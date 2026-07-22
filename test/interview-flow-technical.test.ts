import { describe, expect, it } from "vitest";
import { CODING_QUESTION_SLOT, computeNextTurn, effectiveQuestions } from "@/lib/llm/interview-flow";
import { CODING_QUESTIONS } from "@/lib/fixtures/technical-questions";
import type { HistoryEntry } from "@/lib/types";

function playThrough(name: string, round: "hr" | "technical", role: "general" | "java-sde-fresher" | "frontend-fresher") {
  const history: HistoryEntry[] = [];
  const turns = [];
  for (let i = 0; i < 30; i++) {
    const turn = computeNextTurn(name, history, round, role);
    turns.push(turn);
    history.push({ speaker: "interviewer", text: turn.text });
    if (turn.done) break;
    history.push({
      speaker: "candidate",
      text: "In my project I built the module myself, learned the framework under a deadline, tested it with my team and we shipped it early with measurable results.",
    });
  }
  return turns;
}

describe("technical round flow", () => {
  it("asks exactly 5 main questions with the coding slot at #3", () => {
    const turns = playThrough("Hari", "technical", "java-sde-fresher");
    const mains = turns.filter((t) => t.type === "question");
    expect(mains.length).toBe(5);
    const coding = mains.filter((t) => t.coding);
    expect(coding.length).toBe(1);
    expect(coding[0].questionIndex).toBe(CODING_QUESTION_SLOT);
    expect(coding[0].text).toContain(CODING_QUESTIONS["java-sde-fresher"].text);
    expect(turns[turns.length - 1].done).toBe(true);
  });

  it("greets with the technical persona, not HR", () => {
    const first = computeNextTurn("Hari", [], "technical", "general");
    expect(first.text).toContain("Haris");
    expect(first.type).toBe("greeting");
  });

  it("never offers a follow-up on the coding question", () => {
    const qs = effectiveQuestions("Hari", "technical", "frontend-fresher");
    const codingQ = qs[CODING_QUESTION_SLOT - 1];
    expect(codingQ.coding).toBe(true);
    expect(codingQ.followup).toBe("");
  });

  it("HR round is unchanged: 5 questions, no coding flag anywhere", () => {
    const turns = playThrough("Hari", "hr", "general");
    expect(turns.filter((t) => t.type === "question").length).toBe(5);
    expect(turns.some((t) => t.coding)).toBe(false);
  });

  it("role changes the coding exercise", () => {
    expect(effectiveQuestions("Hari", "technical", "java-sde-fresher")[CODING_QUESTION_SLOT - 1].text).toContain("Java");
    expect(effectiveQuestions("Hari", "technical", "frontend-fresher")[CODING_QUESTION_SLOT - 1].text).toContain("debounce");
  });
});
