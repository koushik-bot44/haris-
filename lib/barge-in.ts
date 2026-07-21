// Barge-in decision logic — pure and unit-testable. This is the August GD
// spike's core problem (mic listening while TTS plays) pulled forward into the
// 1:1 room: the mic hears BOTH the candidate and Priya-through-the-speakers,
// so "someone is talking" is not enough to interrupt. Three defenses:
//   1. Warm-up window: ignore everything briefly after TTS starts (ack echo,
//      speaker pop, recognizer flush).
//   2. Substance threshold: a couple of noise syllables must not cut Priya off.
//   3. Echo filter: if the heard text largely overlaps what Priya is currently
//      SAYING, it is her own voice coming back through the mic — ignore it.

export const BARGE_IN_WARMUP_MS = 600;
export const MIN_INTERRUPT_CHARS = 12;
export const ECHO_OVERLAP_THRESHOLD = 0.6;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Fraction of heard tokens that also appear in the spoken (TTS) text. */
export function echoOverlap(heard: string, spoken: string): number {
  const heardTokens = tokens(heard);
  if (heardTokens.length === 0) return 0;
  const spokenSet = new Set(tokens(spoken));
  const hits = heardTokens.filter((t) => spokenSet.has(t)).length;
  return hits / heardTokens.length;
}

export interface BargeInInput {
  /** Everything heard so far during this TTS turn (finals + interim). */
  heardText: string;
  /** The full text Priya is currently speaking (echo reference). */
  spokenText: string;
  /** ms since the first TTS syllable of this turn. */
  msSinceTtsStart: number;
}

export function decideBargeIn(input: BargeInInput): "interrupt" | "ignore" {
  if (input.msSinceTtsStart < BARGE_IN_WARMUP_MS) return "ignore";
  const heard = input.heardText.trim();
  if (heard.length < MIN_INTERRUPT_CHARS) return "ignore";
  if (echoOverlap(heard, input.spokenText) >= ECHO_OVERLAP_THRESHOLD) return "ignore";
  return "interrupt";
}
