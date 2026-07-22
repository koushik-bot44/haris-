import { describe, expect, it } from "vitest";
import {
  activeTurnIndex,
  criterionTrend,
  formatElapsed,
  gdAirtimeRows,
  latestWeakest,
  questionDenominator,
  roundLabel,
  scoreDots,
  sessionAvg,
  sessionBounds,
  speakerName,
} from "@/lib/report-utils";
import type { RubricEntry, Session, Speaker, Turn } from "@/lib/types";

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

function session(startedAt: number, entries: RubricEntry[], extra?: Partial<Session>): Session {
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
    ...extra,
  };
}

function turn(speaker: Speaker, tStart: number, tEnd: number, extras?: Partial<Turn>): Turn {
  return { speaker, text: "t", tStart, tEnd, ...extras };
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

  it("latestWeakest carries the session id for report links", () => {
    const fix = latestWeakest([session(2, [entry(1, 4, 2, 4, 4)])]);
    expect(fix?.sessionId).toBe("s2");
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

describe("report page + replay helpers", () => {
  it("formatElapsed renders m:ss at turn-level precision", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(161_000)).toBe("2:41");
    expect(formatElapsed(61_400)).toBe("1:01");
    expect(formatElapsed(-5)).toBe("0:00");
  });

  it("sessionBounds spans startedAt to the last turn end", () => {
    const s = session(1000, [], {
      turns: [turn("interviewer", 1000, 2000), turn("candidate", 2000, 9000)],
    });
    expect(sessionBounds(s)).toEqual({ start: 1000, end: 9000 });
    expect(sessionBounds(session(5, []))).toEqual({ start: 5, end: 5 });
  });

  it("activeTurnIndex is the last turn started at or before t", () => {
    const turns = [turn("interviewer", 1000, 2000), turn("candidate", 2500, 4000)];
    expect(activeTurnIndex(turns, 500)).toBe(-1);
    expect(activeTurnIndex(turns, 1000)).toBe(0);
    expect(activeTurnIndex(turns, 2600)).toBe(1);
    expect(activeTurnIndex(turns, 99_999)).toBe(1);
    expect(activeTurnIndex([], 0)).toBe(-1);
  });

  it("speakerName prefers the recorded persona, else the round's default", () => {
    expect(speakerName(turn("candidate", 0, 1), "hr")).toBe("You");
    expect(speakerName(turn("interviewer", 0, 1), "hr")).toBe("Haris");
    expect(speakerName(turn("interviewer", 0, 1), "technical")).toBe("Haris");
    expect(speakerName(turn("interviewer", 0, 1, { personaId: "dominator", personaName: "Axel" }), "gd")).toBe("Axel");
    expect(speakerName(turn("interviewer", 0, 1), "gd")).toBe("Speaker");
  });

  it("roundLabel covers all three round types", () => {
    expect(roundLabel("hr")).toBe("HR");
    expect(roundLabel("technical")).toBe("Technical");
    expect(roundLabel("gd")).toBe("Group Discussion");
  });

  it("questionDenominator derives N from the session, not a constant", () => {
    expect(questionDenominator(session(1, [entry(1, 3, 3, 3, 3), entry(4, 3, 3, 3, 3)]))).toBe(4);
    expect(questionDenominator(session(1, [entry(1, 3, 3, 3, 3), entry(2, 3, 3, 3, 3)]))).toBe(2);
    expect(questionDenominator(session(1, []))).toBe(0);
  });

  it("gdAirtimeRows labels personas from turns, candidate first", () => {
    const s = session(0, [], {
      roundType: "gd",
      turns: [turn("interviewer", 0, 1, { personaId: "dominator", personaName: "Axel" })],
      gdMetrics: {
        airtimeSharePct: 40,
        interjections: [],
        candidateTurns: 3,
        candidateAirtimeMs: 40_000,
        personaAirtimeMs: { dominator: 45_000, unknown: 15_000 },
      },
    });
    const rows = gdAirtimeRows(s);
    expect(rows[0]).toMatchObject({ id: "candidate", label: "You", pct: 40, isCandidate: true });
    expect(rows[1]).toMatchObject({ id: "dominator", label: "Axel", pct: 45, isCandidate: false });
    expect(rows[2]).toMatchObject({ id: "unknown", label: "unknown", pct: 15 });
  });

  it("gdAirtimeRows is empty without gdMetrics or airtime", () => {
    expect(gdAirtimeRows(session(1, []))).toEqual([]);
    const silent = session(1, [], {
      roundType: "gd",
      gdMetrics: {
        airtimeSharePct: 0,
        interjections: [],
        candidateTurns: 0,
        candidateAirtimeMs: 0,
        personaAirtimeMs: {},
      },
    });
    expect(gdAirtimeRows(silent)).toEqual([]);
  });
});
