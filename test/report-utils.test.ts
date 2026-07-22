import { describe, expect, it } from "vitest";
import { criterionTrend, latestWeakest, scoreDots, sessionAvg } from "@/lib/report-utils";
import type { RubricEntry, Session } from "@/lib/types";

function entry(qid: number, r: number, s: number, d: number, c: number, extras?: Partial<RubricEntry>): RubricEntry {
  return {
    questionId: qid,
    question: `Q${qid}`,
    answerTranscript: "answer",
    scores: { relevance: r, structure: s, depth: d, communication: c },
    evidence: {},
    tips: {},
    ...extras,
  };
}

function session(startedAt: number, entries: RubricEntry[]): Session {
  return {
    _id: `s${startedAt}`,
    userId: null,
    role: "general",
    roundType: "hr",
    codingUsed: false,
    startedAt,
    turns: [],
    perQuestionScores: entries,
    deliveryMetrics: null,
    metricsVersion: 1,
    latency: { perTurnMs: [], avgMs: null },
    overall: { avgScore: null, summary: "" },
  };
}

describe("report selectors", () => {
  it("scoreDots and sessionAvg round sensibly", () => {
    const s = session(1, [entry(1, 4, 4, 4, 4), entry(2, 2, 2, 3, 3)]);
    expect(scoreDots(s)).toEqual([4, 3]);
    expect(sessionAvg(s)).toBe(3.3);
  });

  it("latestWeakest picks the lowest criterion of the LATEST session with its evidence", () => {
    const older = session(1, [entry(1, 1, 1, 1, 1)]);
    const latest = session(2, [
      entry(1, 5, 4, 5, 5),
      entry(2, 4, 2, 4, 4, { evidence: { structure: "so basically I just did stuff" }, tips: { structure: "Name the result first." } }),
    ]);
    const fix = latestWeakest([latest, older]);
    expect(fix?.criterion).toBe("structure");
    expect(fix?.score).toBe(2);
    expect(fix?.evidence).toContain("basically");
    expect(fix?.sessionStartedAt).toBe(2);
  });

  it("criterionTrend is chronological and averages per session", () => {
    const a = session(10, [entry(1, 2, 2, 2, 2), entry(2, 4, 4, 4, 4)]);
    const b = session(20, [entry(1, 5, 5, 5, 5)]);
    const trend = criterionTrend([b, a]);
    expect(trend.map((p) => p.t)).toEqual([10, 20]);
    expect(trend[0].scores.relevance).toBe(3);
    expect(trend[1].scores.depth).toBe(5);
  });

  it("empty inputs produce empty/null, never throws", () => {
    expect(latestWeakest([])).toBeNull();
    expect(criterionTrend([])).toEqual([]);
    expect(sessionAvg(session(1, []))).toBeNull();
  });
});
