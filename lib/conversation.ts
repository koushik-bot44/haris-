// Conversation dynamics — the pure decision policy behind the listening
// watcher. A real interviewer reacts to silence in stages (gentle prompt →
// offer to rephrase → move on) and invites more when an answer is thin; this
// module decides WHICH reaction fires on each watcher tick, fully testable
// with no timers, no mic, no browser.

export interface ListenSnapshot {
  msSinceListenStart: number;
  /** null until any speech signal has been detected this answer. */
  msSinceLastSpeech: number | null;
  /** Transcribed words so far (0 while VAD hears energy but text lags). */
  words: number;
  /** Nudges already delivered this answer — the caller increments after each. */
  nudges: number;
}

export type ListenAction =
  | "wait"
  | "end_answer"
  | "nudge_start"
  | "offer_rephrase"
  | "nudge_continue"
  | "give_up";

/** Pause length that ends an answer once speech exists. */
export const PAUSE_END_MS = 1500;
export const NUDGE_START_MS = 7000;
export const OFFER_REPHRASE_MS = 16000;
export const GIVE_UP_MS = 28000;
/** Below this word count a single "go on?" nudge fires before ending. */
export const THIN_ANSWER_WORDS = 15;

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

// ——— Speculative next-turn policy (the sub-second reply path) ———
//
// While the candidate is still mid-answer, a natural pause is a DRAFT POINT:
// the answer is probably nearly done, so the hook fires the next interviewer
// turn against the PARTIAL transcript and pre-synthesizes its audio. If the
// candidate barely adds anything before the answer actually ends, the cached
// turn is delivered instantly; if they keep going, the speculation goes stale
// and a fresh one is armed once the transcript has grown enough.

// Aggressive speculation (tuned after the "voice comes late" feedback): on a
// GPU-less Mac Elena needs ~3s to synthesize, so the ONLY way her reply lands
// instantly is to start generating + synthesizing it WHILE the candidate is
// still talking. Fire early and often — the LLM (Groq) is cheap and the local
// voice is free, so a few discarded speculations are worth an instant reply.

/** Pause length that marks a draft point — well under PAUSE_END_MS, so the
 * speculative request is in flight BEFORE the answer actually ends. */
export const SPECULATE_PAUSE_MS = 500;
/** Below this many words an answer is too thin to speculate on. */
export const SPECULATE_MIN_WORDS = 8;
/** After a speculation fires, the transcript must grow by this many words
 * before a newer speculation replaces it. */
export const SPECULATE_REARM_WORDS = 14;
/** A final transcript that grew by this many words (or more) past the
 * speculative basis invalidates the cached turn. Generous — the deep-dive
 * questions rarely hinge on the candidate's last few words, and an instant
 * on-topic reply beats a perfectly-tailored one that arrives 4s late. */
export const SPECULATION_STALE_WORDS = 16;

/** Draft-point policy: should this listening tick fire a speculative
 * next-turn request? lastBasisWords is the word count the newest outstanding
 * speculation was based on — null when none is outstanding this answer. */
export function shouldSpeculate(s: ListenSnapshot, lastBasisWords: number | null): boolean {
  if (s.msSinceLastSpeech === null || s.msSinceLastSpeech < SPECULATE_PAUSE_MS) return false;
  if (s.words < SPECULATE_MIN_WORDS) return false;
  if (lastBasisWords !== null && s.words - lastBasisWords < SPECULATE_REARM_WORDS) return false;
  return true;
}

/** Acceptance rule at endAnswer: the cached turn is valid when the final
 * transcript barely outgrew the speculative basis. Negative growth (Chrome's
 * settle shrank interim text) accepts — the basis covered everything said. */
export function acceptSpeculation(basisWords: number, finalWords: number): boolean {
  return finalWords - basisWords < SPECULATION_STALE_WORDS;
}

export function decideListenAction(s: ListenSnapshot): ListenAction {
  if (s.msSinceLastSpeech === null) {
    // Total silence since the question. Stages are keyed to the nudge COUNT
    // rather than "has fired" flags — each fires at most once because the
    // caller increments the counter, and a stalled timer still escalates
    // through the stages in order instead of double-firing one of them.
    if (s.msSinceListenStart >= GIVE_UP_MS) return "give_up";
    if (s.msSinceListenStart >= OFFER_REPHRASE_MS && s.nudges === 1) return "offer_rephrase";
    if (s.msSinceListenStart >= NUDGE_START_MS && s.nudges === 0) return "nudge_start";
    return "wait";
  }
  if (s.msSinceLastSpeech >= PAUSE_END_MS) {
    if (s.words < THIN_ANSWER_WORDS && s.nudges === 0) return "nudge_continue";
    return "end_answer";
  }
  return "wait";
}
