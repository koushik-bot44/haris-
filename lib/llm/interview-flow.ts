import type { HistoryEntry, InterviewerTurn, RolePreset } from "@/lib/types";
import { GREETING, HR_QUESTIONS, WRAPUP, type HrQuestion } from "@/lib/fixtures/hr-questions";
import {
  CODING_INTRO,
  CODING_QUESTIONS,
  TECH_GREETING,
  TECH_WRAPUP,
  technicalBank,
} from "@/lib/fixtures/technical-questions";

export const QUESTIONS_PER_INTERVIEW = 5;

/** The coding exercise is ALWAYS main question #3 of a technical round —
 * decided in code, never by a model, so the editor UI is deterministic. */
export const CODING_QUESTION_SLOT = 3;

type FlowQuestion = HrQuestion & { coding?: boolean };

// Deterministic per-session question selection: seed derived from the candidate
// name only, so the same session (same name, growing history) always sees the
// same question set — no Math.random(), which would reshuffle mid-interview.
function seededPick(pool: HrQuestion[], seedStr: string, count: number): HrQuestion[] {
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  const rest = [...pool];
  const picked: HrQuestion[] = [];
  for (let i = 0; i < count && rest.length > 0; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    picked.push(rest.splice(seed % rest.length, 1)[0]);
  }
  return picked;
}

export function effectiveQuestions(
  candidateName: string,
  roundType: "hr" | "technical",
  role: RolePreset,
): FlowQuestion[] {
  const seed = candidateName || "candidate";
  if (roundType === "hr") return seededPick(HR_QUESTIONS, seed, QUESTIONS_PER_INTERVIEW);
  const picked = seededPick(technicalBank(role), seed, QUESTIONS_PER_INTERVIEW - 1);
  const codingQ = CODING_QUESTIONS[role];
  const codingEntry: FlowQuestion = {
    id: codingQ.id,
    text: `${CODING_INTRO} ${codingQ.text}`,
    followup: "",
    expectKeywords: [],
    coding: true,
  };
  const out = [...picked];
  out.splice(CODING_QUESTION_SLOT - 1, 0, codingEntry);
  return out;
}

interface FlowPosition {
  askedMain: number; // main questions already asked
  followupUsedFor: Set<number>; // question indices (1-based) that got a follow-up
  lastWasFollowup: boolean;
  greeted: boolean;
}

/** Reconstruct where we are purely from history — the route is stateless. */
export function readPosition(history: HistoryEntry[], questions: FlowQuestion[]): FlowPosition {
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
    const fIdx = questions.findIndex((q) => q.followup && h.text === q.followup);
    if (fIdx >= 0) {
      pos.followupUsedFor.add(fIdx + 1);
      pos.lastWasFollowup = true;
    }
  }
  return pos;
}

/** Follow-up heuristic: thin answers (short, or missing all expected keywords)
 * earn the canned follow-up — max one per question, never on the coding slot. */
export function wantsFollowup(answer: string, q: FlowQuestion): boolean {
  if (q.coding || !q.followup) return false;
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  if (words < 25) return true;
  const lower = answer.toLowerCase();
  return !q.expectKeywords.some((k) => lower.includes(k));
}

export function computeNextTurn(
  candidateName: string,
  history: HistoryEntry[],
  roundType: "hr" | "technical" = "hr",
  role: RolePreset = "general",
): InterviewerTurn {
  const questions = effectiveQuestions(candidateName, roundType, role);
  const pos = readPosition(history, questions);
  const greet = roundType === "technical" ? TECH_GREETING : GREETING;
  const wrap = roundType === "technical" ? TECH_WRAPUP : WRAPUP;

  if (!pos.greeted) {
    return { type: "greeting", text: greet(candidateName || "there"), questionIndex: 0, done: false };
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
    return { type: "wrapup", text: wrap(candidateName || "and good luck"), questionIndex: 0, done: true };
  }

  const next = questions[pos.askedMain];
  return {
    type: "question",
    text: next.text,
    questionIndex: pos.askedMain + 1,
    done: false,
    ...(next.coding ? { coding: true } : {}),
  };
}
