import type { HistoryEntry, InterviewerTurn } from "@/lib/types";
import { GREETING, HR_QUESTIONS, WRAPUP, type HrQuestion } from "@/lib/fixtures/hr-questions";

export const QUESTIONS_PER_INTERVIEW = 5;

// Deterministic per-session question selection: seed derived from the candidate
// name + history length keeps a session stable across retries without
// Math.random() (which would reshuffle mid-interview).
function seededPick(seedStr: string, count: number): HrQuestion[] {
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  const pool = [...HR_QUESTIONS];
  const picked: HrQuestion[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    picked.push(pool.splice(seed % pool.length, 1)[0]);
  }
  return picked;
}

interface FlowPosition {
  askedMain: number; // main questions already asked
  followupUsedFor: Set<number>; // question indices (1-based) that got a follow-up
  lastWasFollowup: boolean;
  greeted: boolean;
}

/** Reconstruct where we are purely from history — the route is stateless. */
export function readPosition(history: HistoryEntry[], questions: HrQuestion[]): FlowPosition {
  const pos: FlowPosition = { askedMain: 0, followupUsedFor: new Set(), lastWasFollowup: false, greeted: false };
  for (const h of history) {
    if (h.speaker !== "interviewer") continue;
    if (!pos.greeted) {
      pos.greeted = true;
      continue;
    }
    const mainIdx = questions.findIndex((q) => h.text === q.text);
    if (mainIdx >= 0) {
      pos.askedMain = mainIdx + 1;
      pos.lastWasFollowup = false;
      continue;
    }
    const fIdx = questions.findIndex((q) => h.text === q.followup);
    if (fIdx >= 0) {
      pos.followupUsedFor.add(fIdx + 1);
      pos.lastWasFollowup = true;
    }
  }
  return pos;
}

/** Follow-up heuristic: thin answers (short, or missing all expected keywords)
 * earn the canned follow-up — max one per question. */
export function wantsFollowup(answer: string, q: HrQuestion): boolean {
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  if (words < 25) return true;
  const lower = answer.toLowerCase();
  return !q.expectKeywords.some((k) => lower.includes(k));
}

export function computeNextTurn(candidateName: string, history: HistoryEntry[]): InterviewerTurn {
  const questions = seededPick(candidateName || "candidate", QUESTIONS_PER_INTERVIEW);
  const pos = readPosition(history, questions);

  if (!pos.greeted) {
    return { type: "greeting", text: GREETING(candidateName || "there"), questionIndex: 0, done: false };
  }

  const lastCandidate = [...history].reverse().find((h) => h.speaker === "candidate");
  const currentQ = pos.askedMain >= 1 ? questions[pos.askedMain - 1] : null;

  // Candidate just answered a main question → maybe follow up (once per question).
  if (
    currentQ &&
    lastCandidate &&
    !pos.lastWasFollowup &&
    !pos.followupUsedFor.has(pos.askedMain) &&
    wantsFollowup(lastCandidate.text, currentQ)
  ) {
    return { type: "followup", text: currentQ.followup, questionIndex: pos.askedMain, done: false };
  }

  if (pos.askedMain >= QUESTIONS_PER_INTERVIEW) {
    return { type: "wrapup", text: WRAPUP(candidateName || "and good luck"), questionIndex: 0, done: true };
  }

  const next = questions[pos.askedMain];
  return { type: "question", text: next.text, questionIndex: pos.askedMain + 1, done: false };
}
