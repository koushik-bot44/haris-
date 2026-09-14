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
  /** Pause this particular transcript must hold before the turn is handed back
   * (see pauseNeededMs). Absent = the neutral PAUSE_END_MS. */
  pauseNeededMs?: number;
}

export type ListenAction =
  | "wait"
  | "end_answer"
  | "nudge_start"
  | "offer_rephrase"
  | "nudge_continue"
  | "give_up";

// ——— Endpointing: how long a pause must last before the turn changes hands ———
//
// A flat 1.5s was the single largest piece of the dead air between "candidate
// stops" and "interviewer answers", and it was ALSO wrong in the other
// direction: a thinking pause mid-sentence is not the end of a turn. So the
// wait is a function of HOW the transcript trails off (pauseNeededMs below):
// shorter by default, much shorter on an explicit hand-back, and deliberately
// LONGER than the old floor when the words themselves say "not finished".

/** Neutral pause that ends an answer once speech exists — the transcript gives
 * no signal either way (most of Chrome's unpunctuated output). */
export const PAUSE_END_MS = 1200;
/** The candidate said, in so many words, "over to you" — no reason to wait. */
export const PAUSE_END_FAST_MS = 700;
/** Trailing conjunction, preposition, article or filler: they are mid-thought
 * and the next word is coming. Longer than the old flat floor ON PURPOSE. */
export const PAUSE_HOLD_MS = 2000;
export const NUDGE_START_MS = 7000;
export const OFFER_REPHRASE_MS = 16000;
export const GIVE_UP_MS = 28000;
/** Below this word count a single "go on?" nudge fires before ending. */
export const THIN_ANSWER_WORDS = 15;

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Trailing words that mean the sentence is unfinished. Whisper punctuates
 * every segment, so the punctuation alone proves nothing — but nobody ends a
 * turn on "because", "the" or "um", whatever full stop the model appended. */
const CONTINUATION_TAIL = new Set([
  // conjunctions / discourse glue
  "and", "or", "but", "so", "because", "cause", "cos", "since", "although", "though", "while",
  "whereas", "plus", "then", "thus", "therefore", "unless", "until", "before", "after",
  // complementizers and question words mid-sentence
  "that", "which", "who", "whom", "whose", "where", "when", "what", "how", "why", "if", "whether",
  // prepositions
  "to", "of", "in", "on", "at", "for", "with", "from", "by", "about", "into", "onto", "over",
  "under", "between", "through", "during", "against", "towards", "toward", "than", "like", "as",
  // determiners / possessives
  "the", "a", "an", "my", "our", "your", "their", "his", "her", "its", "this", "these", "those",
  "some", "any", "every", "each", "another", "such",
  // auxiliaries and copulas
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "have", "has",
  "had", "will", "would", "can", "could", "should", "shall", "may", "might", "must", "got",
  // a trailing subject pronoun means the verb has not landed yet
  "i", "we", "they", "he", "she", "it", "you",
  // audible thinking
  "um", "uh", "uhm", "erm", "er", "ah", "eh", "hmm", "hm", "mm", "basically", "actually",
  "literally", "kinda", "sorta", "maybe", "just", "really",
]);

/** Explicit hand-backs. Said out loud, these end the turn immediately — the
 * most human latency win available, because the candidate ASKED for it. */
const HAND_BACK_RE =
  /(?:^|\s)(?:that(?:'|’)?s (?:it|all|about it|everything|my answer|pretty much it)|that is (?:it|all)|i(?:'|’)?m done|i am done|i think that(?:'|’)?s (?:it|all)|pretty much it|yeah that(?:'|’)?s it)\s*[.!]?$/i;

/** How long THIS transcript must stay silent before the turn is handed back.
 * Pure: the caller feeds the candidate's text as it stands right now. */
export function pauseNeededMs(transcript: string): number {
  const t = transcript.trim();
  if (!t) return PAUSE_END_MS;
  if (HAND_BACK_RE.test(t)) return PAUSE_END_FAST_MS;
  // A dangling comma/dash is the recognizer's own "…and then": mid-thought.
  if (/[,;:—–-]["')\]]?$/.test(t)) return PAUSE_HOLD_MS;
  const words = t.split(/\s+/);
  const tail = words[words.length - 1].toLowerCase().replace(/[^a-z']/g, "");
  if (CONTINUATION_TAIL.has(tail)) return PAUSE_HOLD_MS;
  return PAUSE_END_MS;
}

// ——— Speculative next-turn policy (the sub-second reply path) ———
//
// While the candidate is still mid-answer, a natural pause is a DRAFT POINT:
// the answer is probably nearly done, so the hook fires the next interviewer
// turn against the PARTIAL transcript and pre-synthesizes its audio. If the
// candidate barely adds anything before the answer actually ends, the cached
// turn is delivered instantly; if they keep going, the speculation goes stale
// and a fresh one is armed once the transcript has grown enough.

// Speculation pre-fetches the NEXT question text (a cheap Groq call) while the
// candidate is still answering, so accepting it skips the LLM round-trip. It
// deliberately does NOT pre-synthesize audio — the single local Chatterbox
// server can't take concurrent synthesis, so the voice is made once, live, at
// endAnswer. Conservative thresholds keep Groq free-tier calls in check.

/** Pause length that marks a draft point — under PAUSE_END_MS, so the
 * speculative request is in flight BEFORE the answer actually ends. Not lower:
 * the VAD cuts a segment at 600ms and its words need a beat to come back, so
 * speculating any earlier would guess against a transcript missing its last
 * sentence — and be rejected at acceptance time for nothing. */
export const SPECULATE_PAUSE_MS = 800;
/** Below this many words an answer is too thin to speculate on. Lowered from
 * 15: short answers are exactly the ones where a full LLM round-trip dominates
 * the gap, and two speculations per answer is a cheap ceiling. */
export const SPECULATE_MIN_WORDS = 10;
/** After a speculation fires, the transcript must grow by this many words
 * before a newer speculation replaces it. */
export const SPECULATE_REARM_WORDS = 18;
/** A final transcript that grew by this many words (or more) past the
 * speculative basis invalidates the cached turn. */
export const SPECULATION_STALE_WORDS = 10;

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
  // The required pause is per-transcript (pauseNeededMs); a caller that does
  // not compute one gets the neutral floor, which is what every existing
  // silence-timer test asserts against.
  if (s.msSinceLastSpeech >= (s.pauseNeededMs ?? PAUSE_END_MS)) {
    if (s.words < THIN_ANSWER_WORDS && s.nudges === 0) return "nudge_continue";
    return "end_answer";
  }
  return "wait";
}
