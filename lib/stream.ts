import type { InterviewerTurn } from "@/lib/types";

// Pure streaming-turn helpers: split spoken text from the @@CTRL control line
// while stdout is still arriving, detect the first complete sentence (voice
// pipelining starts TTS on it before the turn finishes), and parse the
// interview route's SSE frames. No timers, no fetch — fully unit-testable.

/** The control-line marker per the turn protocol: spoken lines, then a FINAL
 * line `@@CTRL {json}`. Only line-INITIAL occurrences count. */
const CTRL_MARKER = "@@CTRL";

/** Split an accumulating raw buffer into displayable spoken text and the
 * control line (null until it appears). A partial line-initial `@@CT…` tail is
 * withheld from text so the marker never flashes in the caption. */
export function accumulateSpokenText(buffer: string): { text: string; ctrlLine: string | null } {
  const m = /(^|\n)@@CTRL/.exec(buffer);
  if (m) {
    const start = m.index + m[1].length;
    const rest = buffer.slice(start);
    const nl = rest.indexOf("\n");
    return {
      text: buffer.slice(0, start).trim(),
      ctrlLine: (nl === -1 ? rest : rest.slice(0, nl)).trim(),
    };
  }
  // Withhold a still-streaming prefix of the marker ("@", "@@", … "@@CTR") when
  // it is the whole last line — the next chunk resolves it either way.
  const lastNl = buffer.lastIndexOf("\n");
  const tail = buffer.slice(lastNl + 1);
  if (tail && tail.length < CTRL_MARKER.length && CTRL_MARKER.startsWith(tail)) {
    return { text: buffer.slice(0, lastNl + 1).trim(), ctrlLine: null };
  }
  return { text: buffer.trim(), ctrlLine: null };
}

/** Sentence boundaries shorter than this are noise ("Hi.") — keep scanning. */
const MIN_SENTENCE_CHARS = 12;

// A '.' ending these is an abbreviation, not a sentence end. Single-letter
// initials ("B. Tech") ride the [A-Za-z] alternative. "Abbreviation-safe
// enough": a missed boundary only merges two sentences into one utterance.
const ABBREV_RE = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc|e\.g|i\.e)|\b[A-Za-z])\.$/i;

/** First COMPLETE sentence of a streaming text, or null while none has closed.
 * Complete = ./!/? followed by whitespace or end-of-buffer, ≥12 chars, not an
 * abbreviation dot. Returned trimmed — remainderAfter() re-anchors it. */
export function firstSentence(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue; // "8.5", "e.g.x" — inside a token
    const candidate = text.slice(0, i + 1).trim();
    if (candidate.length < MIN_SENTENCE_CHARS) continue;
    if (ch === "." && ABBREV_RE.test(candidate)) continue;
    return candidate;
  }
  return null;
}

/** Text remaining after an already-spoken prefix (whitespace-tolerant).
 * Returns "" when spoken isn't found — the milder failure: silence for the
 * tail beats speaking the whole turn twice over itself. */
export function remainderAfter(text: string, spoken: string): string {
  if (!spoken) return text.trim();
  const t = text.trimStart();
  if (t.startsWith(spoken)) return t.slice(spoken.length).trim();
  const idx = text.indexOf(spoken);
  if (idx !== -1) return text.slice(idx + spoken.length).trim();
  return "";
}

// ——— SSE frames from POST /api/interview with stream:true ———

export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "turn"; turn: InterviewerTurn; provider?: string }
  | { kind: "error"; error: string; kind2?: string };

/** Parse complete `data: {json}\n\n` frames out of an accumulating buffer.
 * Returns the events plus the unconsumed remainder (a partial frame). Frames
 * that aren't valid JSON or a known kind are skipped — the caller's no-turn
 * fallback covers anything that mattered. */
export function parseSseEvents(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  let rest = buffer;
  for (;;) {
    const sep = rest.indexOf("\n\n");
    if (sep === -1) break;
    const frame = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      const ev = obj as StreamEvent;
      if (ev?.kind === "text" && typeof ev.text === "string") events.push(ev);
      else if (ev?.kind === "turn" && typeof ev.turn?.text === "string") events.push(ev);
      else if (ev?.kind === "error") events.push(ev);
    }
  }
  return { events, rest };
}
