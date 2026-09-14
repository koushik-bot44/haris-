// Barge-in decision logic — pure and unit-testable. This is the August GD
// spike's core problem (mic listening while TTS plays) pulled forward into the
// 1:1 room: the mic hears BOTH the candidate and the interviewer-through-the-
// speakers, so "someone is talking" is not enough to interrupt.
//
// The mic is now live by DEFAULT (a real interview is interruptible — see
// hooks/useInterviewMachine.ts), which raises the stakes: these rules run for
// every candidate, most of whom demo WITHOUT headphones. A false interrupt (her
// own voice cutting her off mid-question) is far worse than a missed one, so
// five independent defenses must all pass before the floor changes hands:
//   1. Warm-up window: ignore everything briefly after TTS starts (ack echo,
//      speaker pop, recognizer flush).
//   2. Substance threshold: a deliberate interruption is a phrase, not a
//      garbled syllable — require real length AND several words.
//   3. Echo filter: if the heard text overlaps what she is SAYING, it is her
//      own voice through the mic — reject aggressively (recognizers garble her
//      speech, so even partial overlap is a strong echo signal).
//   4. Verbatim-run filter: several of her words heard back-to-back IN ORDER is
//      a recording of her, not a coincidence. Token-SET overlap misses this
//      whenever the recognizer invents enough extra words to dilute the ratio.
//   5. Novel-content floor: a real interruption carries words of its own. A
//      pile of backchannel ("yeah… okay… right… mm-hm") is a candidate
//      LISTENING, not taking the floor — and backchannel is exactly what the
//      mic picks up while she talks.
// The browser's own echo cancellation (getUserMedia echoCancellation:true, set
// by the segmented engines) is the sixth defense and the reason speakers are
// survivable at all; everything here assumes some of it leaks through anyway.

export const BARGE_IN_WARMUP_MS = 1400;
export const MIN_INTERRUPT_CHARS = 24;
export const MIN_INTERRUPT_WORDS = 5;
// Lower = more aggressive echo rejection. At 0.34, a third of heard words
// matching her speech is enough to call it echo and let her keep talking.
export const ECHO_OVERLAP_THRESHOLD = 0.34;
/** Consecutive in-order words of her line = a recording of her, whatever the
 * set-overlap ratio says. Four, not three: candidates legitimately echo a short
 * phrase of the question back ("worked in a team…") while answering it. */
export const ECHO_RUN_TOKENS = 4;
/** Words of the candidate's OWN that an interruption must carry (not filler,
 * not hers). Two is enough for "sorry, could you repeat that" while still
 * rejecting any amount of pure backchannel. */
export const MIN_INTERRUPT_NOVEL_WORDS = 2;

/** Words that carry no intent to take the floor: acknowledgement noises,
 * hedges, and function words. A transcript made only of these is someone
 * listening — or the room — never an interruption. */
const BACKCHANNEL = new Set([
  "yeah", "yes", "yep", "yup", "ok", "okay", "right", "sure", "alright", "true", "exactly", "totally",
  "hmm", "hm", "mm", "mhm", "uh", "um", "erm", "er", "ah", "oh", "eh", "huh", "no", "nope", "nah",
  "so", "and", "but", "or", "like", "just", "really", "actually", "basically", "literally", "well",
  "my", "me", "we", "you", "it", "that", "this", "the", "an", "is", "was", "are", "be", "am",
  "of", "to", "in", "on", "at", "for", "with", "from", "as", "im", "ive", "its",
]);

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

/** Longest run of heard tokens that appears, in the same order, inside the
 * spoken text. Cheap O(n·m) over two short strings — a question is ~30 words. */
export function longestSharedRun(heard: string, spoken: string): number {
  const h = tokens(heard);
  const s = tokens(spoken);
  let best = 0;
  for (let i = 0; i < h.length; i++) {
    for (let j = 0; j < s.length; j++) {
      let k = 0;
      while (i + k < h.length && j + k < s.length && h[i + k] === s[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

/** Heard words that are neither hers nor filler — the candidate's own content. */
export function novelWordCount(heard: string, spoken: string): number {
  const spokenSet = new Set(tokens(spoken));
  return tokens(heard).filter((t) => !spokenSet.has(t) && !BACKCHANNEL.has(t)).length;
}

/** Drop the transcript segments captured BEFORE `upto` that are her own line
 * coming back through the speakers. Segments from `upto` on were heard with the
 * room quiet and are never touched: a candidate who legitimately repeats the
 * question's words while answering must keep them. `upto` is the number of
 * segments the session already held at the moment the mic became the
 * candidate's (barge-in or early start). */
export function dropSelfEcho(segments: string[], spoken: string, upto: number): string[] {
  return segments.filter((seg, i) => i >= upto || echoOverlap(seg, spoken) < ECHO_OVERLAP_THRESHOLD);
}

export interface BargeInInput {
  /** Everything heard so far during this TTS turn (finals + interim). */
  heardText: string;
  /** The full text she is currently speaking (echo reference). */
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
  if (longestSharedRun(heard, input.spokenText) >= ECHO_RUN_TOKENS) return "ignore";
  if (novelWordCount(heard, input.spokenText) < MIN_INTERRUPT_NOVEL_WORDS) return "ignore";
  return "interrupt";
}
