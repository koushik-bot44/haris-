import { describe, expect, it } from "vitest";
import { codingAlreadyAsked, currentStage, stagesFor, CODING_AFTER_ANSWERS } from "@/lib/llm/interview-stages";
import type { HistoryEntry } from "@/lib/types";

/** A transcript with `answers` candidate answers, interleaved. */
function transcript(answers: number, extra: HistoryEntry[] = []): HistoryEntry[] {
  const h: HistoryEntry[] = [];
  for (let i = 0; i < answers; i++) {
    h.push({ speaker: "interviewer", text: `question ${i}` });
    h.push({ speaker: "candidate", text: `answer ${i}` });
  }
  return [...h, ...extra];
}

function stageAt(round: "hr" | "technical", answers: number, history?: HistoryEntry[]) {
  const h = history ?? transcript(answers);
  return currentStage(round, h, { codingAsked: codingAlreadyAsked(h), answers }).stage.key;
}

describe("interview stages", () => {
  it("technical round opens on background, not on a DSA question", () => {
    expect(stageAt("technical", 0)).toBe("background");
    expect(stageAt("technical", 1)).toBe("background");
  });

  it("moves from background into the project deep-dive before any coding", () => {
    expect(stageAt("technical", 2)).toBe("projects");
    expect(stageAt("technical", 3)).toBe("projects");
  });

  it("reaches the coding exercise only after the conversation has run", () => {
    // The regression this encodes: the editor used to open after 2 answers.
    expect(stageAt("technical", CODING_AFTER_ANSWERS - 1)).not.toBe("coding");
    expect(stageAt("technical", CODING_AFTER_ANSWERS)).toBe("coding");
  });

  it("reviews the submitted code before moving on to DSA", () => {
    const handoff: HistoryEntry[] = [
      { speaker: "interviewer", text: "Time for the hands-on question. The editor is open — submit when ready." },
      { speaker: "candidate", text: "public class Solution {}" },
    ];
    const afterCoding = [...transcript(4), ...handoff];
    expect(stageAt("technical", 5, afterCoding)).toBe("code-review");

    const afterReview = [...afterCoding, ...transcript(3)];
    expect(stageAt("technical", 8, afterReview)).toBe("fundamentals");
  });

  it("HR round walks background → projects → behavioural → motivation → practical", () => {
    expect(stageAt("hr", 0)).toBe("background");
    expect(stageAt("hr", 2)).toBe("projects");
    expect(stageAt("hr", 4)).toBe("behavioural");
    expect(stageAt("hr", 6)).toBe("motivation");
    expect(stageAt("hr", 8)).toBe("practical");
  });

  // The candidate's turn has to survive the endgame. When "invite any
  // questions" was one clause inside the wrap-up, a single jump-to-wrapup
  // threshold skipped it entirely — which is how a whole half of the interview
  // silently went missing.
  it("hands the floor to the candidate before closing, in both rounds", () => {
    for (const round of ["hr", "technical"] as const) {
      expect(stageAt(round, 11)).toBe("candidate-questions");
      expect(stageAt(round, 14)).toBe("candidate-questions");
      expect(stageAt(round, 15)).toBe("wrapup");
    }
  });

  it("puts the candidate's questions immediately before the close in both rounds", () => {
    for (const round of ["hr", "technical"] as const) {
      const keys = stagesFor(round).map((s) => s.key);
      expect(keys.at(-2)).toBe("candidate-questions");
      expect(keys.at(-1)).toBe("wrapup");
    }
  });

  it("every stage carries a goal for the prompt, and the last one has no next", () => {
    for (const round of ["hr", "technical"] as const) {
      const stages = stagesFor(round);
      for (const s of stages) expect(s.goal.length).toBeGreaterThan(20);
      const last = currentStage(round, transcript(20), { codingAsked: false, answers: 20 });
      expect(last.next).toBeNull();
    }
  });

  it("detects the coding hand-off from the interviewer's editor phrasing", () => {
    expect(codingAlreadyAsked(transcript(3))).toBe(false);
    expect(
      codingAlreadyAsked([{ speaker: "interviewer", text: "Now let's see some code. Use the editor, submit when ready." }]),
    ).toBe(true);
  });
});

describe("the candidate's half of the interview", () => {
  it("gives the candidate a stage of their own, not a clause in the wrap-up", () => {
    for (const round of ["hr", "technical"] as const) {
      const stage = stagesFor(round).find((s) => s.key === "candidate-questions");
      expect(stage).toBeDefined();
      // It must forbid further interview questions, or it is just more of the
      // same round with a friendlier label.
      expect(stage!.goal).toMatch(/STOP INTERVIEWING THEM/);
      expect(stage!.goal.toLowerCase()).toContain("ask me");
    }
  });

  it("reaches the hand-over from any point in either round", () => {
    // Whatever the round was doing at answer 11 — probing a project, running
    // DSA — it stops asking and gives the floor back.
    for (const round of ["hr", "technical"] as const) {
      for (let a = 11; a < 15; a++) expect(stageAt(round, a)).toBe("candidate-questions");
    }
  });

  it("never closes without the candidate having had the floor", () => {
    // The regression this guards: with a single jump-to-wrapup threshold the
    // candidate's turn was skipped entirely.
    for (const round of ["hr", "technical"] as const) {
      const keys = stagesFor(round).map((s) => s.key);
      expect(keys.indexOf("candidate-questions")).toBeLessThan(keys.indexOf("wrapup"));
      expect(keys.indexOf("candidate-questions")).toBeGreaterThan(0);
    }
  });
});
