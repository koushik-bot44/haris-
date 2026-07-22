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
  if (/^@*\s*\{[^}]*"(?:type|topic|questionIndex|asked|asking|done)"\s*:/.test(t)) return true;
  return false;
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
const CTRL_ANYWHERE =
  /@+\s*CTRL\b|@+\s*\{|\{(?=[^{}]*"(?:type|topic|questionIndex|asked|asking|done)"\s*:)/i;

function findCtrlStart(text: string): number {
  return text.search(CTRL_ANYWHERE);
}

/** Last-ditch scrub: drop any line that still looks like control JSON. The
 * parser above should have removed it, but a stray brace-object must never be
 * read aloud to a candidate. */
function scrubSpoken(text: string): string {
  if (!text.includes("{") && !text.includes("@")) return text.trim();
  return text
    .split(/\r?\n/)
    .filter((l) => !isCtrlLine(l))
    .join("\n")
    .trim();
}

/** Parse a streamed-protocol reply: plain spoken lines + final @@CTRL line.
 * Missing @@CTRL → the whole reply is the spoken text, typed "question" with
 * questionIndex 0 (the provider carries a best-effort topic index; clampTurn
 * still applies). Returns null only when there is no usable spoken text. */
export function parseStreamedTurn(raw: string): InterviewerTurn | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Split speech from control wherever the marker turns up — own line or not.
  const cut = findCtrlStart(trimmed);
  if (cut === -1) {
    const text = scrubSpoken(trimmed).slice(0, 1200);
    if (!text) return null;
    return { type: "reply", text, questionIndex: 0, done: false, asked: looksLikeQuestion(text) };
  }
  const text = scrubSpoken(trimmed.slice(0, cut)).slice(0, 1200);
  if (!text) return null;
  const ctrlPart = trimmed.slice(cut);
  const braceAt = ctrlPart.indexOf("{");
  const jsonPart = braceAt === -1 ? "" : ctrlPart.slice(braceAt, ctrlPart.lastIndexOf("}") + 1);
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
  const cut = findCtrlStart(buffer);
  const spoken = cut === -1 ? buffer : buffer.slice(0, cut);
  // A trailing partial marker is withheld until it can be told from speech —
  // "@@C…", "@" or an opening "@{" must never reach the TTS mid-stream.
  return spoken.replace(/(?:^|\s)@[@\s]*(?:C(?:T(?:R(?:L)?)?)?)?\{?\s*$/i, "").trim();
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

export function deriveProgress(history: HistoryEntry[]): Progress {
  let answers = 0;
  let interviewerTurns = 0;
  for (const h of history) {
    if (h.speaker === "candidate") answers++;
    else interviewerTurns++;
  }
  return { answers, interviewerTurns };
}

export const HARD_STOP_ANSWERS = 16; // 5 deep-dive topics × probe chains need room — never longer

/** Force-terminate runaway interviews regardless of what the model returns. */
export function clampTurn(turn: InterviewerTurn, progress: Progress): InterviewerTurn {
  if (progress.answers >= HARD_STOP_ANSWERS && !turn.done) {
    return { ...turn, type: "wrapup", done: true };
  }
  return turn;
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
