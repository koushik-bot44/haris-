import { describe, expect, it } from "vitest";
import { computeNextTurn, QUESTIONS_PER_INTERVIEW } from "@/lib/llm/interview-flow";
import type { HistoryEntry } from "@/lib/types";

const LONG_ANSWER =
  "In my final year project I led a team of four, we had a conflict about the database choice, " +
  "and I organized a spike to compare both options with real data, then we agreed on the result and " +
  "shipped on time, which taught me to argue with evidence instead of opinions and learn from my team.";

function playThrough(answer: string) {
  const history: HistoryEntry[] = [];
  const turns: string[] = [];
  for (let guard = 0; guard < 30; guard++) {
    const turn = computeNextTurn("hari", history);
    turns.push(turn.type);
    history.push({ speaker: "interviewer", text: turn.text });
    if (turn.done) break;
    history.push({ speaker: "candidate", text: answer });
  }
  return { turns, history };
}

describe("interview flow", () => {
  it("greets first, asks 5 questions, wraps up — no follow-ups for strong answers", () => {
    const { turns } = playThrough(LONG_ANSWER);
    expect(turns[0]).toBe("greeting");
    expect(turns.filter((t) => t === "question").length).toBe(QUESTIONS_PER_INTERVIEW);
    expect(turns[turns.length - 1]).toBe("wrapup");
  });

  it("follows up on thin answers, at most once per question", () => {
    const { turns } = playThrough("I don't know really.");
    const followups = turns.filter((t) => t === "followup").length;
    expect(followups).toBe(QUESTIONS_PER_INTERVIEW); // one per question, never two
    expect(turns[turns.length - 1]).toBe("wrapup");
  });

  it("is deterministic for the same candidate name", () => {
    const a = computeNextTurn("hari", [{ speaker: "interviewer", text: "greeting placeholder" }]);
    const b = computeNextTurn("hari", [{ speaker: "interviewer", text: "greeting placeholder" }]);
    expect(a.text).toBe(b.text);
  });

  it("terminates even on empty answers (no infinite follow-up loop)", () => {
    const { turns } = playThrough("(no answer)");
    expect(turns[turns.length - 1]).toBe("wrapup");
    expect(turns.length).toBeLessThan(20);
  });
});
