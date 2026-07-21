import { describe, expect, it } from "vitest";
import { composeOverall, isScoreable, verifyEvidence, verifyQuote, rubricResponseSchema } from "@/lib/rubric";
import type { RubricEntry } from "@/lib/types";

const TRANSCRIPT =
  "In my final year project I led a team of four, we shipped two weeks early and the client used it every day.";

describe("evidence-quote verification (the thesis protector)", () => {
  it("accepts exact quotes", () => {
    expect(verifyQuote("I led a team of four", TRANSCRIPT)).toBe(true);
  });

  it("forgives ASR punctuation/casing differences", () => {
    expect(verifyQuote("i led a team of four,", TRANSCRIPT)).toBe(true);
    expect(verifyQuote("We shipped TWO WEEKS early", TRANSCRIPT)).toBe(true);
  });

  it("rejects paraphrases and fabrications", () => {
    expect(verifyQuote("I managed four people", TRANSCRIPT)).toBe(false);
    expect(verifyQuote("delivered ahead of schedule", TRANSCRIPT)).toBe(false);
  });

  it("drops unverifiable quotes instead of rendering them", () => {
    const resp = rubricResponseSchema.parse({
      scores: { relevance: 4, structure: 3, depth: 4, communication: 4 },
      evidence: {
        relevance: "I led a team of four", // real
        depth: "we grew revenue by 40%", // fabricated
      },
      tips: {},
    });
    const { evidence, dropped } = verifyEvidence(resp, TRANSCRIPT);
    expect(evidence.relevance).toBe("I led a team of four");
    expect(evidence.depth).toBeUndefined();
    expect(dropped).toEqual(["depth"]);
  });
});

describe("overall composition (coach tone from data)", () => {
  const entry = (r: number, st: number, d: number, c: number): RubricEntry => ({
    questionId: 1,
    question: "Q",
    answerTranscript: "A",
    scores: { relevance: r, structure: st, depth: d, communication: c },
    evidence: {},
    tips: {},
  });

  it("names one strength and one fix — never a failure list", () => {
    const overall = composeOverall([entry(5, 2, 3, 4)]);
    expect(overall.avgScore).toBe(3.5);
    expect(overall.summary).toContain("strength");
    expect(overall.summary).toContain("staying on-point"); // relevance strongest
    expect(overall.summary).toContain("structuring answers"); // structure weakest
  });

  it("handles the unscored round", () => {
    expect(composeOverall([]).avgScore).toBeNull();
  });
});

describe("too-short gate", () => {
  it("refuses to score one-liners", () => {
    expect(isScoreable("I don't know, sorry.")).toBe(false);
    expect(isScoreable(TRANSCRIPT)).toBe(true);
  });
});
