import type { GdInterjection, GdMetrics, SttTraceEvent, Turn } from "@/lib/types";
import { dropSelfEcho, echoOverlap, ECHO_OVERLAP_THRESHOLD } from "@/lib/barge-in";

// Pure GD scoring: airtime per speaker, interjection detection, and the
// coach-tone verdict. No clocks, no randomness — everything derives from the
// recorded turn timeline, so tests and the report replay the same numbers.
//
// Which is exactly why the FIRST half of this file exists: every number below
// is only as honest as the timeline it is handed. Three ways the live room used
// to lie to it — a persona cut off mid-word recorded as having said its whole
// line, a candidate turn backdated to the persona's echo in the mic, and two
// different definitions of "what the candidate has said on this floor" — are
// fixed by the pure helpers here, so the fix is testable without a browser.

export const INTERJECTION_WINDOW_MS = 800;
export const BUILD_OVERLAP_THRESHOLD = 0.15;
export const AIRTIME_BAND: [number, number] = [20, 35];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

// ——— honest timeline: what was actually SAID, and by whom, and when ———

/** Fallback speaking rate until the room has measured its own voice. Neural TTS
 * lands around 150–175 wpm; at ~5.5 characters per word that is ~15 chars/sec.
 * Only ever an estimate — it decides where an interrupted line is cut, never
 * whether the interruption happened. */
export const NOMINAL_SPEECH_CHARS_PER_MS = 0.0155;

/** A turn shorter than this is too short to calibrate from (synthesis latency
 * and the trailing silence dominate it). */
export const MIN_RATE_SAMPLE_MS = 2500;

/** Sanity band, ~6 to ~35 chars/sec. A wildly wrong measurement (a turn whose
 * audio never started, a tab throttled in the background) must not make the
 * next interruption cut at word one or not at all. */
const RATE_BAND: [number, number] = [0.006, 0.035];

/** Characters-per-ms actually observed across the persona turns that ran to
 * completion this round. Falls back to nominal until there is enough of a
 * sample — which is normal for an interruption during the opening line. */
export function speechRateCharsPerMs(chars: number, ms: number): number {
  if (!Number.isFinite(chars) || !Number.isFinite(ms)) return NOMINAL_SPEECH_CHARS_PER_MS;
  if (chars <= 0 || ms < MIN_RATE_SAMPLE_MS) return NOMINAL_SPEECH_CHARS_PER_MS;
  return clamp(RATE_BAND[0], RATE_BAND[1], chars / ms);
}

/** The part of `text` that was actually audible before the voice was cancelled.
 *
 * A persona cut off mid-word used to be recorded — and fed back to the debate
 * engine as history — as having said its ENTIRE line, so the next batch reacted
 * to sentences nobody in the room ever heard, and the airtime numbers counted
 * words that were never spoken. Cutting on a word boundary and marking the cut
 * with an em dash is what an interruption looks like in a real transcript.
 *
 * Returns "" when the voice was killed before a single whole word landed — the
 * caller drops the turn entirely rather than recording a phantom speaker. */
export function spokenPrefix(text: string, elapsedMs: number, charsPerMs = NOMINAL_SPEECH_CHARS_PER_MS): string {
  const full = text.trim();
  if (!full) return "";
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return "";
  const rate = Number.isFinite(charsPerMs) && charsPerMs > 0 ? charsPerMs : NOMINAL_SPEECH_CHARS_PER_MS;
  const chars = elapsedMs * rate;
  if (chars >= full.length) return full; // the cancel landed on (or past) the last syllable
  const head = full.slice(0, Math.floor(chars));
  const boundary = head.lastIndexOf(" ");
  if (boundary <= 0) return "";
  const spoken = head.slice(0, boundary).trim().replace(/[\s,;:.!?—-]+$/, "");
  return spoken ? `${spoken}—` : "";
}

/** What the mic heard BEFORE the candidate took the floor: how many final
 * segments already existed, and the persona line that was playing (the echo
 * reference for those segments). */
export interface FloorAdoption {
  finals: number;
  echoRef: string;
}

/** The final segments that belong to the CANDIDATE on this floor.
 *
 * Pre-adoption segments are kept only when they are not the persona's own line
 * coming back through the speakers — an early start (the candidate began during
 * the tail of a persona turn) is genuine floor speech that predates the floor.
 * This is the single definition; the silence watchdog and the transcript builder
 * both call it. They used to compute it differently, and the disagreement made
 * every early-start interjection sit out the full empty-floor timeout while its
 * words were already in the transcript.
 *
 * Deliberately a thin wrapper over the 1:1 room's `dropSelfEcho` rather than a
 * second copy of its filter: the echo threshold and the "everything from the
 * adoption index on is theirs" rule are ONE rule for both rooms, so a tuning
 * change in lib/barge-in.ts cannot leave the GD floor behind. */
export function candidateFinals(finalSegments: string[], adopted: FloorAdoption | null): string[] {
  if (!adopted) return finalSegments;
  return dropSelfEcho(finalSegments, adopted.echoRef, adopted.finals);
}

/** The interruption bookkeeping for one persona turn. `promoted` — the
 * candidate took the floor over this line — and `cutOff` — the voice was
 * still audible when they did — are deliberately separate. */
export interface InterruptMark {
  promoted: boolean;
  cutOff: boolean;
}

/** Record that the candidate took the floor over a persona turn.
 *
 * Only an interruption that lands while the audio is still playing cuts the
 * recorded line short (spokenPrefix + em dash). A SPACE press that arrives
 * after the last syllable — in the window between the audio ending and the
 * turn's bookkeeping clearing — still hands the floor over, but the persona
 * DID say the whole line, so it must be recorded whole: otherwise a fully
 * spoken sentence gets a spurious "—" in the transcript and the debate
 * history. The first interruption decides; a repeat can never re-cut it. */
export function markInterrupt(mark: InterruptMark, audioEnded: boolean): void {
  if (!mark.promoted) mark.cutOff = !audioEnded;
  mark.promoted = true;
}

/** Barge-in needs several non-echo words before it fires, so the candidate's
 * first syllable can legitimately predate the floor by a couple of seconds —
 * but never by more than this. Anything older is the persona through the mic. */
export const MAX_EARLY_START_MS = 6000;

/** When the candidate's turn actually began.
 *
 * The mic is live through the whole persona turn, so its trace opens with the
 * persona's own voice. Taking the first result in the trace backdated the
 * candidate's turn to that echo — inflating their airtime by the length of a
 * persona line and turning every floor into a phantom "interjection". Skip
 * results that are echo of the line that was playing, and never reach further
 * back than one barge-in's worth of speech. */
export function candidateTurnStart(
  trace: SttTraceEvent[],
  floorStartT: number,
  adopted: FloorAdoption | null,
): number {
  const earliest = floorStartT - MAX_EARLY_START_MS;
  for (const e of trace) {
    if (e.kind !== "result" || !e.text.trim()) continue;
    // Heard after the grab: unambiguously theirs, and everything before it was
    // already rejected below.
    if (e.t >= floorStartT) return e.t;
    if (e.t < earliest) continue;
    if (adopted && echoOverlap(e.text, adopted.echoRef) >= ECHO_OVERLAP_THRESHOLD) continue;
    return e.t;
  }
  return floorStartT;
}

/** Fraction of candidate tokens that also appear in the previous persona turn. */
export function buildOverlap(candidateText: string, personaText: string): number {
  const cand = tokens(candidateText);
  if (cand.length === 0) return 0;
  const prev = new Set(tokens(personaText));
  return cand.filter((t) => prev.has(t)).length / cand.length;
}

export function airtimeFromTurns(turns: Turn[], discussionStartT: number): GdMetrics {
  const personaAirtimeMs: Record<string, number> = {};
  const interjections: GdInterjection[] = [];
  let candidateAirtimeMs = 0;
  let candidateTurns = 0;
  let prevPersona: Turn | null = null;

  for (const t of turns) {
    const dur = Math.max(0, t.tEnd - t.tStart);
    if (t.speaker === "candidate") {
      candidateTurns++;
      candidateAirtimeMs += dur;
      // Interjection: the candidate began while the previous persona turn was
      // nominally still active, or within the window right after it ended.
      if (prevPersona && t.tStart <= prevPersona.tEnd + INTERJECTION_WINDOW_MS) {
        interjections.push({
          tMs: Math.max(0, t.tStart - discussionStartT),
          builtOnPrevious: buildOverlap(t.text, prevPersona.text) >= BUILD_OVERLAP_THRESHOLD,
        });
      }
    } else {
      const id = t.personaId ?? "persona";
      personaAirtimeMs[id] = (personaAirtimeMs[id] ?? 0) + dur;
      prevPersona = t;
    }
  }

  const personaTotal = Object.values(personaAirtimeMs).reduce((a, b) => a + b, 0);
  const total = personaTotal + candidateAirtimeMs;
  return {
    airtimeSharePct: total > 0 ? Math.round((candidateAirtimeMs / total) * 1000) / 10 : 0,
    interjections,
    candidateTurns,
    candidateAirtimeMs,
    personaAirtimeMs,
  };
}

function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 5 inside the ideal band; linear falloff on both sides (silence-adjacent
 * shares fall faster than domination — talking too little is the worse habit). */
export function airtimeScore(sharePct: number): number {
  const [lo, hi] = AIRTIME_BAND;
  if (sharePct >= lo && sharePct <= hi) return 5;
  if (sharePct < lo) return clamp(1, 5, 5 - (lo - sharePct) * 0.2);
  return clamp(1, 5, 5 - (sharePct - hi) * 0.08);
}

/** No interjections is neutral (spoke only in gaps); otherwise the build ratio
 * decides — interjections that build read as listening, derails read as noise. */
export function interjectionScore(m: GdMetrics): number {
  if (m.interjections.length === 0) return 3;
  const built = m.interjections.filter((i) => i.builtOnPrevious).length;
  return clamp(1, 5, 2 + 3 * (built / m.interjections.length));
}

/** Coach-tone verdict composed from data (no LLM call): one strength + one
 * priority fix, silence flagged warmly, never a list of failures. */
export function composeGdVerdict(
  m: GdMetrics,
  opts?: { micTrouble?: boolean },
): { avgScore: number | null; summary: string } {
  // A dead mic must never read as a silent candidate: when STT degraded during
  // the round and nothing of theirs was captured, the round is honestly unscored.
  if (opts?.micTrouble && m.candidateAirtimeMs === 0) {
    return {
      avgScore: null,
      summary:
        "Your microphone stopped working during this discussion, so nothing you said could be " +
        "captured — this round isn't scored. That's an equipment problem, not a performance one: " +
        "check the address-bar mic permission (Google Chrome works best) and run another round.",
    };
  }

  if (m.candidateTurns === 0) {
    return {
      avgScore: null,
      summary:
        "You listened the whole discussion without taking the floor — that happens to almost everyone " +
        "in a first GD, and it's fixable. Next time, grab the floor once in the first two minutes " +
        "(hold SPACE): one clear early point beats a perfect point never made.",
    };
  }

  const [lo, hi] = AIRTIME_BAND;
  const share = Math.round(m.airtimeSharePct * 10) / 10;
  const total = m.interjections.length;
  const built = m.interjections.filter((i) => i.builtOnPrevious).length;
  const derailed = total - built;
  const inBand = share >= lo && share <= hi;

  let strength: string;
  if (inBand) {
    strength = `you held ${share}% of the airtime — squarely in the healthy ${lo}–${hi}% band`;
  } else if (built > 0 && built >= derailed) {
    strength = `${built} of your ${total} interjection${total === 1 ? "" : "s"} built directly on the previous speaker's point — that reads as listening, not waiting to talk`;
  } else if (m.candidateTurns >= 2) {
    strength = `you took the floor ${m.candidateTurns} times without waiting to be invited`;
  } else {
    strength = `you got your voice into a loud room — that's the hardest first step`;
  }

  let fix: string;
  if (share < lo) {
    fix = `you held only ${share}% of the airtime — push toward the ${lo}–${hi}% band by taking the floor earlier and more often`;
  } else if (share > hi) {
    fix = `you held ${share}% of the airtime — a strong GD candidate also creates space; invite a quieter voice in and build on others' points`;
  } else if (derailed > built) {
    fix = `${derailed} of your ${total} interjections changed the subject instead of building on the last speaker — link your point to theirs first`;
  } else if (total === 0) {
    fix = `all your speaking came when the floor was free — practice one polite mid-flow interjection per discussion`;
  } else {
    fix = `keep the same airtime while sharpening one point with a number or example — depth is your next lever`;
  }

  const avg = 0.6 * airtimeScore(share) + 0.4 * interjectionScore(m);
  return {
    avgScore: Math.round(clamp(1, 5, avg) * 10) / 10,
    summary: `Your strength this round: ${strength}. One thing to work on before the next GD: ${fix}.`,
  };
}
