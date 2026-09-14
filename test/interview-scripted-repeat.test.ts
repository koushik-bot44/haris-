import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InterviewRequest } from "@/lib/types";

// REGRESSION: the scripted interviewer must never repeat itself inside one round.
//
// When long-term memory started feeding an `avoid` list into the question bank,
// the list was built from peekAskedQuestions() — which includes an in-process
// record of the questions asked in the CURRENT session. So it grew by one on
// every turn. computeNextTurn filters the bank by `avoid` BEFORE drawing, so the
// pool size (and therefore every subsequent modulo) changed mid-round, the
// remaining questions re-ordered, and readPosition — which locates progress by
// exact-text lookup into that same set — stopped recognising what had already
// been asked. The observed damage: an HR round that asked three of five
// questions with indices skipping 1 -> 3 -> 5, and spoke one follow-up three
// times, twice back to back.
//
// The fix is that `avoid` carries CROSS-SESSION memory only. Keeping this
// session's questions out of this round is readPosition's job.
//
// Note there is deliberately NO Supermemory key here: rememberAskedQuestion
// records in-process regardless of the key, which is exactly the path that broke.

vi.mock("@/lib/llm/chat", () => ({
  // No LLM key: every turn takes the scripted rescue, which is the path that
  // runs when Groq's daily quota is spent, a call times out, or the key is
  // missing — and the only path in the fixture-bank demo configuration.
  chatConfig: () => null,
  isReasoningModel: () => false,
  chatComplete: vi.fn(),
}));

import { apiProvider } from "@/lib/llm/api-provider";
import { resetMemoryCaches } from "@/lib/memory";

const SUBJECT = "guest-aaaaaaaa-bbbb-cccc-dddd";

const ANSWER =
  "I worked on a payment reconciliation service last year and the hardest part was making the ledger " +
  "idempotent so retries could not double count anything.";

/** Drive a full scripted round the way the route does, turn by turn. */
async function runRound(roundType: "hr" | "technical", memoryKey?: string) {
  const history: InterviewRequest["history"] = [];
  const turns = [];
  for (let i = 0; i < 16; i++) {
    const turn = await apiProvider.nextTurn(
      { role: "general", roundType, candidateName: "Hari", history },
      memoryKey ? { memoryKey } : {},
    );
    turns.push(turn);
    history.push({ speaker: "interviewer", text: turn.text });
    if (turn.done) break;
    history.push({ speaker: "candidate", text: ANSWER });
  }
  return turns;
}

beforeEach(() => {
  vi.stubEnv("SUPERMEMORY_API_KEY", "");
  resetMemoryCaches();
});

describe("scripted round — no repeats within a session", () => {
  for (const roundType of ["hr", "technical"] as const) {
    it(`${roundType}: never speaks the same line twice`, async () => {
      const turns = await runRound(roundType, SUBJECT);
      const spoken = turns.map((t) => t.text.trim());
      const duplicates = spoken.filter((t, i) => spoken.indexOf(t) !== i);
      expect(duplicates).toEqual([]);
    });

    it(`${roundType}: never speaks the same line twice IN A ROW`, async () => {
      // The most demo-visible form of the bug.
      const spoken = (await runRound(roundType, SUBJECT)).map((t) => t.text.trim());
      const backToBack = spoken.filter((t, i) => i > 0 && spoken[i - 1] === t);
      expect(backToBack).toEqual([]);
    });

    it(`${roundType}: main question indices advance one at a time, never skipping`, async () => {
      const turns = await runRound(roundType, SUBJECT);
      const mains = turns.filter((t) => t.type === "question").map((t) => t.questionIndex);
      // Strictly increasing, and no gaps: 1 -> 3 -> 5 was the symptom.
      expect(mains).toEqual([...mains].sort((a, b) => a - b));
      for (let i = 1; i < mains.length; i++) {
        expect(mains[i] - mains[i - 1]).toBeLessThanOrEqual(1);
      }
    });

    it(`${roundType}: a follow-up never precedes the question it belongs to`, async () => {
      // Orphaned follow-ups ("That could apply to almost any company…" before any
      // company question was asked) were the other half of the corruption.
      const turns = await runRound(roundType, SUBJECT);
      let seenMain = 0;
      for (const t of turns) {
        if (t.type === "question") seenMain = Math.max(seenMain, t.questionIndex);
        if (t.type === "followup" && t.questionIndex > 0) {
          expect(t.questionIndex).toBeLessThanOrEqual(seenMain);
        }
      }
    });

    it(`${roundType}: behaves identically with and without a memory subject`, async () => {
      // A candidate with no stored history must get exactly the round a
      // candidate with memory disabled gets — the avoid list only ever removes
      // questions from EARLIER sessions, and there are none here.
      const withMemory = (await runRound(roundType, SUBJECT)).map((t) => t.text);
      resetMemoryCaches();
      const without = (await runRound(roundType)).map((t) => t.text);
      expect(withMemory).toEqual(without);
    });
  }

  it("hr: asks the whole set of main questions, not a subset", async () => {
    const turns = await runRound("hr", SUBJECT);
    const mains = turns.filter((t) => t.type === "question");
    // The bug delivered 3 of 5. Any healthy round asks several distinct mains.
    expect(mains.length).toBeGreaterThanOrEqual(4);
    const distinct = new Set(mains.map((t) => t.text.trim()));
    expect(distinct.size).toBe(mains.length);
  });
});
