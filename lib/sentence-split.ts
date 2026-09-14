// Sentence segmentation for voice pipelining — pure, unit-testable.
//
// The interviewer's reply streams in token by token. Speaking can start the
// moment the FIRST sentence closes, while the model is still writing the
// rest — that is the difference between "waits two seconds, then talks" and a
// conversation. This module finds closed sentences in a growing buffer and
// remembers what it has already handed out, so the same sentence is never
// spoken twice and a boundary is never called early ("8." → "8.5").

/** Sentence boundaries shorter than this are noise ("Hi.") — keep scanning
 * so they merge into the next sentence instead of becoming a tiny utterance. */
export const MIN_SENTENCE_CHARS = 12;

// A '.' ending these is an abbreviation, not a sentence end. Single-letter
// initials ("B. Tech") ride the [A-Za-z] alternative.
const ABBREV_RE = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc|e\.g|i\.e|no|st|approx)|\b[A-Za-z])\.$/i;

/** Characters that may trail a terminator and still belong to the sentence. */
const TRAILER_RE = /[.!?"'”’)\]]/;

export interface SplitResult {
  sentences: string[];
  /** Index into the input where the unconsumed remainder begins. */
  consumed: number;
  /** The unconsumed remainder, trimmed (may be a sentence still streaming). */
  rest: string;
}

/** Closed sentences in `text`: a terminator (./!/?) followed by whitespace,
 * at least MIN_SENTENCE_CHARS long, not an abbreviation dot. A terminator at
 * the very END of the buffer is NOT a boundary (the buffer may still grow —
 * "8." might become "8.5"); pass `final: true` to close it. */
export function completeSentences(text: string, final = false): SplitResult {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    let j = i;
    while (j + 1 < text.length && TRAILER_RE.test(text[j + 1])) j++;
    const next = text[j + 1];
    if (next === undefined) {
      if (!final) break;
    } else if (!/\s/.test(next)) {
      i = j;
      continue; // "8.5", "e.g.x" — inside a token
    }
    const candidate = text.slice(start, j + 1).trim();
    if (candidate.length < MIN_SENTENCE_CHARS) {
      i = j;
      continue;
    }
    if (ch === "." && j === i && ABBREV_RE.test(candidate)) continue;
    sentences.push(candidate);
    start = j + 1;
    i = j;
  }
  return { sentences, consumed: start, rest: text.slice(start).trim() };
}

/** Everything in `text` as speakable chunks — closed sentences plus whatever
 * trails them. For speaking a COMPLETE text (nothing is still streaming). */
export function splitForSpeech(text: string): string[] {
  const { sentences, rest } = completeSentences(text, true);
  return rest ? [...sentences, rest] : sentences;
}

/** Incremental splitter over a growing (prefix-stable) text. Each feed()
 * returns only the NEWLY closed sentences. If the text stops being an
 * extension of what was already handed out (a rescue replaced the reply),
 * `reset` is true and the caller must restart its voice. */
export class SentenceStreamer {
  private consumed = 0;
  private prefix = "";

  /** Text already handed out as sentences, exactly as it appeared. */
  get spoken(): string {
    return this.prefix.trim();
  }

  feed(text: string): { sentences: string[]; reset: boolean } {
    let reset = false;
    if (!text.startsWith(this.prefix)) {
      reset = true;
      this.consumed = 0;
      this.prefix = "";
    }
    const { sentences, consumed } = completeSentences(text.slice(this.consumed));
    if (sentences.length) {
      this.consumed += consumed;
      this.prefix = text.slice(0, this.consumed);
    }
    return { sentences, reset };
  }

  /** The tail of the FINAL text not yet spoken. `mismatch` means the final
   * text does not contain what was already spoken — the caller should cancel
   * the voice and speak the final text in full. */
  flush(finalText: string): { rest: string; mismatch: boolean } {
    const spoken = this.spoken;
    if (!spoken) return { rest: finalText.trim(), mismatch: false };
    const t = finalText.trimStart();
    if (t.startsWith(spoken)) return { rest: t.slice(spoken.length).trim(), mismatch: false };
    const idx = finalText.indexOf(spoken);
    if (idx !== -1) return { rest: finalText.slice(idx + spoken.length).trim(), mismatch: false };
    return { rest: "", mismatch: true };
  }
}
