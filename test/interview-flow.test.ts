import { describe, expect, it } from "vitest";
import {
  CODING_QUESTION_SLOT,
  computeNextTurn,
  DEEP_PROBES,
  effectiveQuestions,
  MAX_FOLLOWUPS_PER_QUESTION,
  QUESTIONS_PER_INTERVIEW,
} from "@/lib/llm/interview-flow";
import { HR_QUESTIONS } from "@/lib/fixtures/hr-questions";
import { technicalBank } from "@/lib/fixtures/technical-questions";
import type { HistoryEntry, InterviewerTurn, RolePreset } from "@/lib/types";

const LONG_ANSWER =
  "In my final year project I led a team of four, we had a conflict about the database choice, " +
  "and I organized a spike to compare both options with real data, then we agreed on the result and " +
  "shipped on time, which taught me to argue with evidence instead of opinions and learn from my team.";

function playThrough(
  answer: string,
  roundType: "hr" | "technical" = "hr",
  role: RolePreset = "general",
) {
  const history: HistoryEntry[] = [];
  const turns: InterviewerTurn[] = [];
  for (let guard = 0; guard < 40; guard++) {
    const turn = computeNextTurn("hari", history, roundType, role);
    turns.push(turn);
    history.push({ speaker: "interviewer", text: turn.text });
    if (turn.done) break;
    history.push({ speaker: "candidate", text: answer });
  }
  return { turns, history };
}

describe("interview flow", () => {
  it("greets first, asks 5 questions, wraps up — no follow-ups for strong answers", () => {
    const { turns } = playThrough(LONG_ANSWER);
    expect(turns[0].type).toBe("greeting");
    expect(turns.filter((t) => t.type === "question").length).toBe(QUESTIONS_PER_INTERVIEW);
    expect(turns[turns.length - 1].type).toBe("wrapup");
  });

  it("chains up to 2 follow-ups per question on thin answers, never a third", () => {
    const { turns } = playThrough("I don't know really.");
    const followups = turns.filter((t) => t.type === "followup");
    // Every question earns the full chain: canned follow-up + deep probe.
    expect(followups.length).toBe(QUESTIONS_PER_INTERVIEW * MAX_FOLLOWUPS_PER_QUESTION);
    // Never more than the chain per question index.
    const perQuestion = new Map<number, number>();
    for (const f of followups) perQuestion.set(f.questionIndex, (perQuestion.get(f.questionIndex) ?? 0) + 1);
    for (const count of perQuestion.values()) expect(count).toBeLessThanOrEqual(MAX_FOLLOWUPS_PER_QUESTION);
    expect(turns[turns.length - 1].type).toBe("wrapup");
  });

  it("second-level probes keep the parent questionIndex (scoring identity)", () => {
    const { turns } = playThrough("I don't know really.");
    let currentQuestion = 0;
    for (const t of turns) {
      if (t.type === "question") currentQuestion = t.questionIndex;
      if (t.type === "followup") expect(t.questionIndex).toBe(currentQuestion);
    }
  });

  it("deep probes never collide with fixture question or follow-up text", () => {
    const fixtureTexts = new Set<string>();
    for (const q of HR_QUESTIONS) {
      fixtureTexts.add(q.text);
      fixtureTexts.add(q.followup);
    }
    for (const role of ["general", "java-sde-fresher", "frontend-fresher"] as const) {
      for (const q of technicalBank(role)) {
        fixtureTexts.add(q.text);
        fixtureTexts.add(q.followup);
      }
    }
    for (const probe of [...DEEP_PROBES.hr, ...DEEP_PROBES.technical]) {
      expect(fixtureTexts.has(probe)).toBe(false);
    }
  });

  it("picks deep probes deterministically — same session, same probes", () => {
    const a = playThrough("I don't know really.");
    const b = playThrough("I don't know really.");
    expect(a.turns.map((t) => t.text)).toEqual(b.turns.map((t) => t.text));
  });

  it("is deterministic for the same candidate name", () => {
    const a = computeNextTurn("hari", [{ speaker: "interviewer", text: "greeting placeholder" }]);
    const b = computeNextTurn("hari", [{ speaker: "interviewer", text: "greeting placeholder" }]);
    expect(a.text).toBe(b.text);
  });

  it("terminates even on empty answers (no infinite follow-up loop)", () => {
    const { turns } = playThrough("(no answer)");
    expect(turns[turns.length - 1].type).toBe("wrapup");
    // greeting + 5 × (question + 2 follow-ups) + wrapup = 17 turns max.
    expect(turns.length).toBeLessThan(20);
  });

  it("keeps the coding slot at #3 in technical rounds, with no follow-ups on it", () => {
    const { turns } = playThrough("I don't know really.", "technical", "java-sde-fresher");
    const coding = turns.filter((t) => t.coding);
    expect(coding.length).toBe(1);
    expect(coding[0].questionIndex).toBe(CODING_QUESTION_SLOT);
    const codingFollowups = turns.filter((t) => t.type === "followup" && t.questionIndex === CODING_QUESTION_SLOT);
    expect(codingFollowups.length).toBe(0);
    expect(turns[turns.length - 1].type).toBe("wrapup");
  });

  it("effectiveQuestions puts the coding entry at the slot with an empty followup", () => {
    const qs = effectiveQuestions("hari", "technical", "general");
    expect(qs[CODING_QUESTION_SLOT - 1].coding).toBe(true);
    expect(qs[CODING_QUESTION_SLOT - 1].followup).toBe("");
  });
});
