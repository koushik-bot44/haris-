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
