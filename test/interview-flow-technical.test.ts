import { describe, expect, it } from "vitest";
import { CODING_QUESTION_SLOT, computeNextTurn, effectiveQuestions } from "@/lib/llm/interview-flow";
import { codingQuestionFor, codingSeedFrom } from "@/lib/fixtures/technical-questions";
import { NO_ANSWER } from "@/lib/llm/parse";
import type { HistoryEntry } from "@/lib/types";

const ANSWER =
  "In my project I built the module myself, learned the framework under a deadline, tested it with my team and we shipped it early with measurable results.";

function playThrough(name: string, round: "hr" | "technical", role: "general" | "java-sde-fresher" | "frontend-fresher") {
  const history: HistoryEntry[] = [];
  const turns = [];
  for (let i = 0; i < 30; i++) {
    const turn = computeNextTurn(name, history, round, role);
    turns.push(turn);
    history.push({ speaker: "interviewer", text: turn.text });
    if (turn.done) break;
    history.push({ speaker: "candidate", text: ANSWER });
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
    expect(turns[turns.length - 1].done).toBe(true);
  });

  it("speaks the SAME seeded coding problem the client's editor shows", () => {
    const turns = playThrough("Hari", "technical", "java-sde-fresher");
    const coding = turns.find((t) => t.coding)!;
    // The client seeds the editor from the candidate name + first answer.
    const seed = codingSeedFrom("Hari", [{ speaker: "candidate", text: ANSWER }]);
    const expected = codingQuestionFor("java-sde-fresher", undefined, seed);
    expect(coding.text).toContain(expected.text);
  });

  it("re-asks a question once after silence, then moves on", () => {
    const history: HistoryEntry[] = [];
    const greet = computeNextTurn("Hari", history, "hr", "general");
    history.push({ speaker: "interviewer", text: greet.text });
    history.push({ speaker: "candidate", text: ANSWER });
    const q1 = computeNextTurn("Hari", history, "hr", "general");
    expect(q1.type).toBe("question");
    history.push({ speaker: "interviewer", text: q1.text });
    history.push({ speaker: "candidate", text: NO_ANSWER });
    const reask = computeNextTurn("Hari", history, "hr", "general");
    expect(reask.type).toBe("reply");
    expect(reask.asked).toBe(true);
    expect(reask.text).toContain(q1.text);
    expect(reask.questionIndex).toBe(q1.questionIndex);
    history.push({ speaker: "interviewer", text: reask.text });
    history.push({ speaker: "candidate", text: NO_ANSWER });
    const next = computeNextTurn("Hari", history, "hr", "general");
    expect(next.text).not.toContain(q1.text); // second silence: move on
  });

  it("rescuing a model-driven interview does not restart at question one", () => {
    const history: HistoryEntry[] = [
      { speaker: "interviewer", text: "Hi Hari, welcome — let's begin." },
      { speaker: "candidate", text: ANSWER },
      { speaker: "interviewer", text: "Tell me about the hardest bug in that project." },
      { speaker: "candidate", text: ANSWER },
      { speaker: "interviewer", text: "What would you change about the architecture now?" },
      { speaker: "candidate", text: ANSWER },
      { speaker: "interviewer", text: "How did the team split the work?" },
      { speaker: "candidate", text: ANSWER },
      { speaker: "interviewer", text: "What did you learn from shipping early?" },
      { speaker: "candidate", text: ANSWER },
      { speaker: "interviewer", text: "Where did the deadline pressure show up?" },
      { speaker: "candidate", text: ANSWER },
    ];
    const turn = computeNextTurn("Hari", history, "hr", "general");
    // The claim under test is the POSITION — the rescue must not rewind to
    // topic one. Whether it opens that topic or probes it is the keyword
    // heuristic's call, and since the bank is now picked per session (the seed
    // includes the opening turn) the question sitting at this slot varies, so
    // an answer that hit one question's expected keywords misses another's.
    // Both are mid-interview turns, which is the whole assertion.
    expect(["question", "followup"]).toContain(turn.type);
    expect(turn.questionIndex).toBeGreaterThanOrEqual(2);
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
