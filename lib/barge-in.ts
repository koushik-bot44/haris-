// Barge-in decision logic — pure and unit-testable. This is the August GD
// spike's core problem (mic listening while TTS plays) pulled forward into the
// 1:1 room: the mic hears BOTH the candidate and Priya-through-the-speakers,
// so "someone is talking" is not enough to interrupt. Four defenses, tuned
// conservatively because most users demo WITHOUT headphones — a false interrupt
// (her own voice cutting her off) is far worse than a missed one:
//   1. Warm-up window: ignore everything briefly after TTS starts (ack echo,
//      speaker pop, recognizer flush).
//   2. Substance threshold: a deliberate interruption is a phrase, not a garbled
//      syllable — require real length AND several words.
//   3. Echo filter: if the heard text overlaps what Priya is SAYING, it is her
//      own voice through the mic — reject aggressively (Chrome garbles her
//      speech, so even partial overlap is a strong echo signal).

export const BARGE_IN_WARMUP_MS = 1400;
export const MIN_INTERRUPT_CHARS = 28;
export const MIN_INTERRUPT_WORDS = 5;
// Lower = more aggressive echo rejection. At 0.34, a third of heard words
// matching her speech is enough to call it echo and let her keep talking.
export const ECHO_OVERLAP_THRESHOLD = 0.34;

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
  if (tokens(heard).length < MIN_INTERRUPT_WORDS) return "ignore";
  if (echoOverlap(heard, input.spokenText) >= ECHO_OVERLAP_THRESHOLD) return "ignore";
  return "interrupt";
}
