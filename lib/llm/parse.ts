import { z } from "zod";
import type { HistoryEntry, InterviewerTurn } from "@/lib/types";

// Pure helpers for LLM-backed providers: response parsing/clamping and
// progress derivation. Kept out of the provider so they're unit-testable
// without spawning anything.

const turnSchema = z.object({
  type: z.enum(["greeting", "reply", "question", "followup", "wrapup"]),
  text: z.string().min(1).max(1200),
  questionIndex: z.number().int().min(0).max(5).catch(0),
  done: z.boolean().catch(false),
  asked: z.boolean().optional().catch(undefined),
});

// ——— streamed turn protocol (claude-cli): spoken text lines, then a FINAL
// control line `@@CTRL {"type":...,"questionIndex":N,"done":false,"coding":false}`.
// Text streams to the client as it arrives; the control line never reaches TTS.

export const CTRL_PREFIX = "@@CTRL";

// Junk control fields degrade to defaults instead of killing the turn — the
// spoken text is the valuable part; clampTurn still bounds the interview.
const ctrlSchema = z.object({
  // Defaults to "reply", not "question": if the model did not tell us it opened
  // a topic, the safe assumption is that it was just talking. Guessing
  // "question" is what silently advanced the interview past people.
  type: z.enum(["greeting", "reply", "question", "followup", "wrapup"]).catch("reply"),
  questionIndex: z.number().int().min(0).max(5).catch(0),
  done: z.boolean().catch(false),
  asked: z.boolean().optional().catch(undefined),
  coding: z.boolean().optional().catch(undefined),
});

/** Did this turn actually put a question to the candidate? Checked against the
 * spoken text rather than the model's own claim, because the claim is wrong
 * often enough to matter and interview progress depends on it. Anywhere in the
 * text, not just the end: "Java does have loops. What does a for loop do?" is
 * a question turn even though a correction came first. */
function looksLikeQuestion(text: string): boolean {
  return text.includes("?");
}

/** Is this line the model's control line rather than something to say aloud?
 *
 * Deliberately generous. Models improvise the marker — an observed reply used
 * `@{"type":"reply","asking":false,"topic":0}` instead of `@@CTRL {...}` — and
 * a marker we fail to recognise does not degrade gracefully: it gets spoken by
 * the TTS and printed in the caption. Anything that is line-initial and shaped
 * like control JSON is control, never speech.
 *
 * Only line-initial counts, so a candidate discussing "@@CTRL" in their code is
 * still quoted back to them normally. */
function isCtrlLine(line: string): boolean {
  const t = line.trimStart();
  if (t.startsWith(CTRL_PREFIX)) return true; // @@CTRL {...}
  if (/^@+\s*CTRL\b/i.test(t)) return true; // @CTRL, @@@CTRL, @ CTRL
  if (/^@*\s*\{[^}]*"(?:type|topic|questionIndex|asked|asking|done)"\s*:/.test(t)) {
    // Same rule as controlStartFor: a bare object with speech AFTER its closing
    // brace is being quoted, not emitted — `{"type":"error"} is what it sent
    // back. Why?` must not lose the whole line to this scrub.
    if (t.startsWith("@")) return true;
    const end = objectEnd(t, t.indexOf("{"));
    return end === -1 || !t.slice(end + 1).trim();
  }
  return false;
}

/** Index of the brace that closes the object opening at `text[start]`, or -1
 * while it is still open. String-aware, so a "}" inside a value does not close
 * it and a "{" inside one does not nest. This is what lets the control JSON be
 * cut out as ONE balanced object: the old first-"{"-to-last-"}" slice swallowed
 * everything between two control lines — or between a quoted object and the
 * real one — and the whole turn then fell back to default control fields. */
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

const TURN_TYPES = new Set(["greeting", "reply", "question", "followup", "wrapup"]);

/** Could this closed, unmarked object be the model's control line at all? It
 * has to parse, and if it names a `type` it has to be one of ours: a quoted
 * `{"type":"error","done":true}` at the very end of a sentence used to be
 * adopted wholesale — the speech truncated at the brace AND the interview
 * ended on that done:true. Unparseable text is still treated as control, as
 * before: it is never worth reading JSON-shaped junk aloud. */
function plausibleBareControl(json: string): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return true;
  }
  if (obj === null || typeof obj !== "object") return true;
  const type = (obj as Record<string, unknown>).type;
  return typeof type !== "string" || TURN_TYPES.has(type);
}

/** First control line; mid-text occurrences are spoken content. */
function ctrlLineIndex(lines: string[]): number {
  return lines.findIndex(isCtrlLine);
}

/** Where the control block starts anywhere in the reply, or -1.
 *
 * Models do not reliably put the marker on its own line — observed live:
 * `Hello Rohan, nice to finally dig in. @@CTRL {"type":"greeting",...}` all on
 * one line. A line-initial-only check speaks that aloud, marker and JSON
 * included, so the marker is hunted anywhere it appears.
 *
 * The bare-brace form additionally requires a control key, so a candidate
 * saying "then I return an object" is never mistaken for control. */
/** Just the explicit, "@"-prefixed forms — the half of the hunt that can never
 * be mistaken for speech. */
const CTRL_MARKER = /@+\s*CTRL\b|@+\s*\{/i;

/** The other half: an unmarked object carrying a control key. */
const CTRL_BARE = /\{(?=[^{}]*"(?:type|topic|questionIndex|asked|asking|done)"\s*:)/;

/** Where the control block starts in a COMPLETE reply.
 *
 * Same hunt as findCtrlStart, with one extra rule for the BARE-BRACE form: it
 * only counts as control when nothing but whitespace follows its closing brace.
 *
 * The bare-brace rule exists because models improvise the marker, and its
 * comment defends it against prose ("then I return an object") — which does not
 * cover a model QUOTING an actual object back at the candidate. A technical
 * round discussing a response body would hit
 *   Your handler returned {"type":"error","done":true} — why not a 4xx?
 * and the old code took that as control: it truncated the spoken text at the
 * brace (losing the actual question) AND adopted done:true, ending the whole
 * interview on a flag the interviewer never meant. Truncating quoted speech is
 * a defensible tradeoff; silently ending the round is not.
 *
 * An explicit @@CTRL marker stays unambiguous and keeps working anywhere. */
function controlStartFor(text: string, streaming = false): number {
  // An explicit "@" marker is unambiguous, so it wins wherever it appears —
  // including when the reply ALSO quotes a control-shaped object earlier, which
  // is the case the bare-brace rule below would otherwise cut at.
  const marked = text.search(CTRL_MARKER);
  if (marked !== -1) return marked;
  // Every bare-brace candidate in turn, not just the first: a reply that quotes
  // one object and then emits its real control line used to be cut at the
  // QUOTE, which threw away the question and left the control JSON unreadable.
  let from = 0;
  for (;;) {
    const rel = text.slice(from).search(CTRL_BARE);
    if (rel === -1) return -1;
    const cut = from + rel;
    const end = objectEnd(text, cut);
    if (end === -1) return cut; // still unclosed — control (or still forming)
    if (text.slice(end + 1).trim()) {
      from = end + 1; // speech follows the brace: quoted, keep looking
      continue;
    }
    // Closed, and nothing follows. Mid-stream that is exactly what a control
    // line looks like one tick before the newline arrives, so it is withheld;
    // on the complete reply it still has to look like OUR control object.
    return streaming || plausibleBareControl(text.slice(cut, end + 1)) ? cut : -1;
  }
}

/** Last-ditch scrub: drop any line that still looks like control JSON. The
 * parser above should have removed it, but a stray brace-object must never be
 * read aloud to a candidate. */
function scrubSpoken(text: string): string {
  if (!text.includes("{") && !text.includes("@")) return text.trim();
  return text
    .split(/\r?\n/)
    .filter((l) => !isCtrlLine(l))
    // Control put BEFORE the speech on the same line (`{"type":"reply",…} Nice
    // to meet you.`) — strip the object and keep the words, rather than dropping
    // the line (which emptied the turn) or reading the JSON aloud.
    .map(stripLeadingControl)
    .join("\n")
    .trim();
}

function stripLeadingControl(line: string): string {
  const t = line.trimStart();
  if (!/^@*\s*\{[^}]*"(?:type|topic|questionIndex|asked|asking|done)"\s*:/.test(t)) return line;
  const at = t.indexOf("{");
  const end = objectEnd(t, at);
  // `{"type":"error"} is what it sent back. Why?` is a quote — same test as
  // controlStartFor: only something that could be OUR object gets stripped.
  if (end === -1 || (!t.startsWith("@") && !plausibleBareControl(t.slice(at, end + 1)))) return line;
  return t.slice(end + 1).trim();
}

/** Parse a streamed-protocol reply: plain spoken lines + final @@CTRL line.
 * Missing @@CTRL → the whole reply is the spoken text, typed "question" with
 * questionIndex 0 (the provider carries a best-effort topic index; clampTurn
 * still applies). Returns null only when there is no usable spoken text. */
export function parseStreamedTurn(raw: string): InterviewerTurn | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Split speech from control wherever the marker turns up — own line or not.
  const cut = controlStartFor(trimmed);
  if (cut === -1) {
    const text = scrubSpoken(trimmed).slice(0, 1200);
    if (!text) return null;
    return { type: "reply", text, questionIndex: 0, done: false, asked: looksLikeQuestion(text) };
  }
  const text = scrubSpoken(trimmed.slice(0, cut)).slice(0, 1200);
  if (!text) return null;
  const ctrlPart = trimmed.slice(cut);
  const braceAt = ctrlPart.indexOf("{");
  // ONE balanced object, not first-"{"-to-last-"}": a model that repeats its
  // control line (observed) used to hand JSON.parse two objects glued together
  // and lose every control field to the defaults. Unclosed → the old slice.
  const closeAt = braceAt === -1 ? -1 : objectEnd(ctrlPart, braceAt);
  const jsonPart =
    braceAt === -1 ? "" : ctrlPart.slice(braceAt, (closeAt === -1 ? ctrlPart.lastIndexOf("}") : closeAt) + 1);
  let obj: unknown = null;
  try {
    obj = JSON.parse(jsonPart);
  } catch {
    obj = null;
  }
  if (obj === null || typeof obj !== "object") {
    // Unreadable control JSON: keep the speech, default the control fields.
    return { type: "reply", text, questionIndex: 0, done: false, asked: looksLikeQuestion(text) };
  }
  // Accept the names models actually emit, not only the ones we asked for.
  const raw2 = obj as Record<string, unknown>;
  const normalized = {
    ...raw2,
    questionIndex: raw2.questionIndex ?? raw2.topic,
    asked: raw2.asked ?? raw2.asking,
  };
  const ctrl = ctrlSchema.parse(normalized); // every field .catch-es — never throws on objects
  // `asked` is not taken on trust. Models report it unreliably — observed
  // asked:false on a turn ending "...what inspired you to take it on?" — and
  // interview progress hangs off it. The text is the ground truth: if a
  // question was actually put to the candidate, it was asked.
  const asked = Boolean(ctrl.asked) || looksLikeQuestion(text);
  // A turn that asked nothing belongs to no topic, whatever the model claims.
  // Otherwise pure conversation silently consumes interview progress — the
  // exact behaviour this redesign exists to remove.
  const isChat = ctrl.type === "reply" && !asked;
  return {
    type: ctrl.type,
    text,
    questionIndex: isChat ? 0 : ctrl.questionIndex,
    done: ctrl.done,
    asked,
    ...(ctrl.coding ? { coding: true } : {}),
  };
}

/** Spoken text visible in a partially streamed reply: everything before the
 * first line-initial @@CTRL; a trailing partial "@@C…" prefix on the last line
 * is withheld until disambiguated (so TTS never speaks half a control marker). */
export function visibleStreamText(buffer: string): string {
  // The streaming cut follows the parser's rule, so the caption never shows
  // less than the final turn will say. It used to cut at the FIRST bare-brace
  // candidate, so a quoted `{"type":"error"} and then it crashed. Why?` stayed
  // frozen at "it returned" for the whole stream and the rest of the question
  // arrived in one lump with the final turn.
  const cut = controlStartFor(buffer, true);
  const spoken = cut === -1 ? buffer : buffer.slice(0, cut);
  // A trailing partial marker is withheld until it can be told from speech —
  // "@@C…", "@" or an opening "@{" must never reach the TTS mid-stream.
  return (
    spoken
      .replace(/(?:^|\s)@[@\s]*(?:C(?:T(?:R(?:L)?)?)?)?\{?\s*$/i, "")
      // …and so must a trailing UNCLOSED brace that could still become the
      // bare-brace control form. CTRL_ANYWHERE only matches once the first
      // control KEY is complete ('{"type":'), so without this the fragments
      // '{', '{"', '{"t', '{"ty' … each reach the TTS and the caption on
      // successive stream ticks, and the visible text then SHRINKS when the key
      // finally completes — which cannot un-speak what was already said.
      // Requires no '}' yet, so a closed object the interviewer is quoting
      // ("it returned {}") is left alone.
      .replace(/(?:^|\s)@*\s*\{\s*"?[A-Za-z]*"?\s*:?\s*$/, "")
      .trim()
  );
}

/** Parse a model reply into an InterviewerTurn. Tolerates code fences and
 * surrounding prose; returns null on anything unusable (caller falls back). */
export function parseInterviewerJson(raw: string): InterviewerTurn | null {
  const text = raw.trim();
  // Grab the first {...} block — models love wrapping JSON in fences/prose.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = turnSchema.safeParse(obj);
  if (!parsed.success) return null;
  return parsed.data;
}

export interface Progress {
  answers: number;
  interviewerTurns: number;
}

/** Recorded by the room when a listening window closes with nothing said —
 * silence, a failed mic, or the candidate giving up on a question. It is NOT an
 * answer, and treating it as one is how an interview walks off without you. */
export const NO_ANSWER = "(no answer)";
/** Recorded when the microphone HEARD the candidate but no words came back
 * from the recogniser (a failed or empty transcription). Not silence: the
 * interviewer must say the words did not come through, never behave as if the
 * candidate had said nothing. */
export const UNHEARD = "(unheard)";
/** Appended to an answer when one of its segments was lost by the recogniser —
 * the missing part must not be read as "they did not say it". */
export const PARTIAL_MARK = "(part of the answer was not captured)";

export function isNoAnswer(text: string): boolean {
  const t = text.trim();
  return t === NO_ANSWER || t === UNHEARD;
}

export function isUnheard(text: string): boolean {
  return text.trim() === UNHEARD;
}

export function isPartialCapture(text: string): boolean {
  return text.includes(PARTIAL_MARK);
}

export function stripCaptureMarks(text: string): string {
  return text.split(PARTIAL_MARK).join(" ").replace(/\s{2,}/g, " ").trim();
}

export function deriveProgress(history: HistoryEntry[]): Progress {
  let answers = 0;
  let interviewerTurns = 0;
  for (const h of history) {
    // Silence must not advance the interview. It used to count exactly like a
    // real answer, so a candidate who said nothing still watched the stage
    // machine march forward and the topics get used up — "it's going as if I
    // answered". Progress means answers, not turns.
    if (h.speaker === "candidate") {
      if (!isNoAnswer(h.text)) answers++;
    } else interviewerTurns++;
  }
  return { answers, interviewerTurns };
}

export const HARD_STOP_ANSWERS = 16; // 5 deep-dive topics × probe chains need room — never longer
/** Interviewer turns (answers or not) after which the round closes regardless —
 * keeps the transcript inside the request schema's history cap. */
export const HARD_STOP_INTERVIEWER_TURNS = 50;

/** Force-terminate runaway interviews regardless of what the model returns. */
export function clampTurn(turn: InterviewerTurn, progress: Progress): InterviewerTurn {
  if ((progress.answers >= HARD_STOP_ANSWERS || progress.interviewerTurns >= HARD_STOP_INTERVIEWER_TURNS) && !turn.done) {
    return { ...turn, type: "wrapup", done: true };
  }
  return turn;
}

/** Is the candidate ASKING something? Speech recognition almost never emits a
 * question mark, so "what is the tech stack" must count as much as "…?". */
export function looksLikeCandidateQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith("?")) return true;
  if (t.split(/\s+/).length > 30) return false; // a long answer is an answer
  return /^(?:(?:so|and|but|okay|ok|um|uh|hmm|also|just|quick question|one question|i have a question)[,\s]+)*(?:what|what's|whats|how|how's|why|when|where|which|who|who's|is|are|am|do|does|did|can|could|would|will|should|shall|may|have|has|tell me about|could you tell|can you tell)\b/.test(
    t,
  );
}

/** How many recent entries stay verbatim. The whole transcript used to ship on
 * every turn, so token cost grew with the square of interview length — and on
 * a 12k-tokens-per-minute free tier that is what quietly pushes a long
 * interview over the cap and into the scripted fallback, one turn at a time.
 *
 * The opening exchange is always kept regardless: it carries the candidate's
 * own introduction (name, background, projects), which is the memory the
 * interviewer most needs to sound like it was listening. */
export const TRANSCRIPT_WINDOW = 14;
const TRANSCRIPT_HEAD = 2;

export function transcriptFor(history: HistoryEntry[], personaName: string = "Interviewer"): string {
  const line = (h: HistoryEntry) =>
    `${h.speaker === "interviewer" ? personaName : "Candidate"}: ${h.text}`;
  if (history.length <= TRANSCRIPT_WINDOW + TRANSCRIPT_HEAD) {
    return history.map(line).join("\n");
  }
  const head = history.slice(0, TRANSCRIPT_HEAD).map(line);
  const tail = history.slice(-TRANSCRIPT_WINDOW).map(line);
  return [...head, "(earlier turns omitted)", ...tail].join("\n");
}
