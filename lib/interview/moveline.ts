// The model's proposed move travels as one line, `@@MOVE {json}`, ahead of the
// spoken words. It is cut out here before anything is parsed as speech, so a
// move can never be read aloud — and the application validates it before the
// turn is used at all.

export const MOVE_PREFIX = "@@MOVE";

/** Index of the brace closing the object that opens at text[start], or -1.
 * String-aware, like the control-line parser. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

export function splitMoveLine(raw: string): { move: unknown | null; rest: string } {
  const m = /@@\s*MOVE\b\s*:?\s*/i.exec(raw);
  if (!m) return { move: null, rest: raw };
  const after = m.index + m[0].length;
  if (raw[after] !== "{") return { move: null, rest: (raw.slice(0, m.index) + raw.slice(after)).trim() };
  const end = objectEnd(raw, after);
  let move: unknown = null;
  try {
    move = JSON.parse(raw.slice(after, end === -1 ? undefined : end + 1));
  } catch {
    move = null;
  }
  const rest = (raw.slice(0, m.index) + (end === -1 ? "" : raw.slice(end + 1))).trim();
  return { move, rest };
}

/** The private `note` a model may add to its control line — context for later
 * turns, never spoken and never scored. */
export function ctrlNote(raw: string): string | null {
  const at = raw.search(/@@\s*CTRL/i);
  if (at === -1) return null;
  const brace = raw.indexOf("{", at);
  if (brace === -1) return null;
  const end = objectEnd(raw, brace);
  if (end === -1) return null;
  try {
    const obj = JSON.parse(raw.slice(brace, end + 1)) as { note?: unknown };
    return typeof obj.note === "string" && obj.note.trim() ? obj.note.trim().slice(0, 160) : null;
  } catch {
    return null;
  }
}
