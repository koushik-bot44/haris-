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

/** Models improvise the marker: "@MOVE", "MOVE:", or a bare {"action":…}
 * object. Every form is removed from the spoken text; only a real object is
 * kept as the move. A capitalised "Move" inside speech survives because the
 * marker must be followed by an object. */
const MOVE_MARKER = /(?:^|\n)[ \t]*@{0,3}[ \t]*MOVE\b[ \t]*:?[ \t]*(?=\{)|@@\s*MOVE\b\s*:?\s*(?=\{)/i;
const BARE_MOVE_LINE = /^[ \t]*@*[ \t]*\{[^}]*"action"\s*:[^}]*\}?[ \t]*$/;

export function splitMoveLine(raw: string): { move: unknown | null; rest: string } {
  const m = MOVE_MARKER.exec(raw);
  let move: unknown = null;
  let rest = raw;
  if (m) {
    const after = m.index + m[0].length;
    const end = objectEnd(raw, after);
    try {
      move = JSON.parse(raw.slice(after, end === -1 ? undefined : end + 1));
    } catch {
      move = null;
    }
    rest = raw.slice(0, m.index) + (end === -1 ? "" : raw.slice(end + 1));
  }
  // A move object on its own line with no marker at all.
  const lines = rest.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (BARE_MOVE_LINE.test(line)) {
      if (move === null) {
        try {
          const at = line.indexOf("{");
          const end = objectEnd(line, at);
          move = JSON.parse(line.slice(at, end === -1 ? undefined : end + 1));
        } catch {
          move = null;
        }
      }
      continue;
    }
    kept.push(line);
  }
  return { move, rest: kept.join("\n").trim() };
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
