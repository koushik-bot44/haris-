import { z } from "zod";
import type { HistoryEntry, InterviewerTurn } from "@/lib/types";

// Pure helpers for LLM-backed providers: response parsing/clamping and
// progress derivation. Kept out of the provider so they're unit-testable
// without spawning anything.

const turnSchema = z.object({
  type: z.enum(["greeting", "question", "followup", "wrapup"]),
  text: z.string().min(1).max(1200),
  questionIndex: z.number().int().min(0).max(5).catch(0),
  done: z.boolean().catch(false),
});

// ——— streamed turn protocol (claude-cli): spoken text lines, then a FINAL
// control line `@@CTRL {"type":...,"questionIndex":N,"done":false,"coding":false}`.
// Text streams to the client as it arrives; the control line never reaches TTS.

export const CTRL_PREFIX = "@@CTRL";

// Junk control fields degrade to defaults instead of killing the turn — the
// spoken text is the valuable part; clampTurn still bounds the interview.
const ctrlSchema = z.object({
  type: z.enum(["greeting", "question", "followup", "wrapup"]).catch("question"),
  questionIndex: z.number().int().min(0).max(5).catch(0),
  done: z.boolean().catch(false),
  coding: z.boolean().optional().catch(undefined),
});

/** First line whose (whitespace-trimmed) start is the @@CTRL marker — mid-text
 * occurrences are spoken content, only line-initial counts. */
function ctrlLineIndex(lines: string[]): number {
  return lines.findIndex((l) => l.trimStart().startsWith(CTRL_PREFIX));
}

/** Parse a streamed-protocol reply: plain spoken lines + final @@CTRL line.
 * Missing @@CTRL → the whole reply is the spoken text, typed "question" with
 * questionIndex 0 (the provider carries a best-effort topic index; clampTurn
 * still applies). Returns null only when there is no usable spoken text. */
export function parseStreamedTurn(raw: string): InterviewerTurn | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/);
  const ctrlIdx = ctrlLineIndex(lines);
  if (ctrlIdx === -1) {
    return { type: "question", text: trimmed.slice(0, 1200), questionIndex: 0, done: false };
  }
  const text = lines.slice(0, ctrlIdx).join("\n").trim().slice(0, 1200);
  if (!text) return null;
  const jsonPart = lines[ctrlIdx].trimStart().slice(CTRL_PREFIX.length).trim();
  let obj: unknown = null;
  try {
    obj = JSON.parse(jsonPart);
  } catch {
    obj = null;
  }
  if (obj === null || typeof obj !== "object") {
    // Unreadable control JSON: keep the speech, default the control fields.
    return { type: "question", text, questionIndex: 0, done: false };
  }
  const ctrl = ctrlSchema.parse(obj); // every field .catch-es — never throws on objects
  return {
    type: ctrl.type,
    text,
    questionIndex: ctrl.questionIndex,
    done: ctrl.done,
    ...(ctrl.coding ? { coding: true } : {}),
  };
}

/** Spoken text visible in a partially streamed reply: everything before the
 * first line-initial @@CTRL; a trailing partial "@@C…" prefix on the last line
 * is withheld until disambiguated (so TTS never speaks half a control marker). */
export function visibleStreamText(buffer: string): string {
  const lines = buffer.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith(CTRL_PREFIX)) break;
    if (i === lines.length - 1 && t.length > 0 && CTRL_PREFIX.startsWith(t)) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
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

export function transcriptFor(history: HistoryEntry[], personaName: string = "Interviewer"): string {
  return history
    .map((h) => `${h.speaker === "interviewer" ? personaName : "Candidate"}: ${h.text}`)
    .join("\n");
}
