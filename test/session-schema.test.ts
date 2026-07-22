import { describe, expect, it } from "vitest";
import { sessionSchema } from "@/lib/session-schema";
import type { Session } from "@/lib/types";

const baseSession: Session = {
  _id: "3b241101-e2bb-4255-8caf-4136c566a962",
  userId: null,
  role: "general",
  roundType: "hr",
  codingUsed: false,
  startedAt: 1_753_150_000_000,
  turns: [
    { speaker: "interviewer", text: "Tell me about yourself.", tStart: 1000, tEnd: 4000 },
    { speaker: "candidate", text: "I'm a final-year CS student.", tStart: 5000, tEnd: 9000 },
  ],
  perQuestionScores: [
    {
      questionId: 1,
      question: "Tell me about yourself.",
      answerTranscript: "I'm a final-year CS student.",
      scores: { relevance: 4, structure: 3, depth: 3, communication: 4 },
      evidence: { relevance: "stayed on the question" },
      tips: { structure: "use STAR" },
    },
  ],
  deliveryMetrics: { wpm: 130, fillerCount: 2, hesitationCount: 1, longestPauseMs: 1800 },
  metricsVersion: 1,
  latency: { perTurnMs: [900, 1100], avgMs: 1000 },
  overall: { avgScore: 3.5, summary: "Solid start; tighten structure." },
};

const gdSession: Session = {
  ...baseSession,
  _id: "9c8d7e6f-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  roundType: "gd",
  topic: "Is remote work here to stay?",
  turns: [
    {
      speaker: "interviewer",
      text: "I'll open: remote work is a productivity trap.",
      tStart: 1000,
      tEnd: 6000,
      personaId: "dominator",
      personaName: "Axel",
    },
    { speaker: "candidate", text: "The data says otherwise.", tStart: 7000, tEnd: 10000 },
  ],
  gdMetrics: {
    airtimeSharePct: 34.5,
    interjections: [{ tMs: 7000, builtOnPrevious: true }],
    candidateTurns: 1,
    candidateAirtimeMs: 3000,
    personaAirtimeMs: { dominator: 5000, moderator: 2000 },
  },
  retries: [
    {
      questionId: 1,
      answerTranscript: "Retake: studies show output holds steady.",
      scores: { relevance: 5, structure: 4, depth: 4, communication: 4 },
      at: 1_753_150_100_000,
    },
  ],
};

describe("session schema — round-trips", () => {
  it("accepts and round-trips a plain HR session unchanged", () => {
    const parsed = sessionSchema.safeParse(baseSession);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(baseSession);
  });

  it("accepts and round-trips a GD session with gdMetrics/topic/retries/personaId", () => {
    const parsed = sessionSchema.safeParse(gdSession);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(gdSession);
  });

  it("accepts a signed-in user's session (userId string)", () => {
    expect(sessionSchema.safeParse({ ...baseSession, userId: "google:1234567890" }).success).toBe(true);
  });
});

describe("session schema — rejections", () => {
  it("rejects junk extra keys (strict — the DB stores what clients send)", () => {
    expect(sessionSchema.safeParse({ ...baseSession, $where: "1" }).success).toBe(false);
    const junkTurn = { ...baseSession.turns[0], injected: true };
    expect(sessionSchema.safeParse({ ...baseSession, turns: [junkTurn] }).success).toBe(false);
  });

  it("rejects non-object and half-shaped payloads", () => {
    expect(sessionSchema.safeParse(null).success).toBe(false);
    expect(sessionSchema.safeParse("session").success).toBe(false);
    expect(sessionSchema.safeParse({ _id: "abc12345" }).success).toBe(false);
  });

  it("caps turns at 200", () => {
    const turns = Array.from({ length: 201 }, () => baseSession.turns[0]);
    expect(sessionSchema.safeParse({ ...baseSession, turns }).success).toBe(false);
    const ok = Array.from({ length: 200 }, () => baseSession.turns[0]);
    expect(sessionSchema.safeParse({ ...baseSession, turns: ok }).success).toBe(true);
  });

  it("caps text fields at 8000", () => {
    const long = { ...baseSession.turns[0], text: "x".repeat(8001) };
    expect(sessionSchema.safeParse({ ...baseSession, turns: [long] }).success).toBe(false);
    const summary = "x".repeat(8001);
    expect(sessionSchema.safeParse({ ...baseSession, overall: { avgScore: null, summary } }).success).toBe(false);
  });

  it("caps perQuestionScores at 20", () => {
    const scores = Array.from({ length: 21 }, () => baseSession.perQuestionScores[0]);
    expect(sessionSchema.safeParse({ ...baseSession, perQuestionScores: scores }).success).toBe(false);
  });

  it("rejects out-of-range rubric scores and unknown enums", () => {
    const bad = {
      ...baseSession.perQuestionScores[0],
      scores: { relevance: 6, structure: 3, depth: 3, communication: 4 },
    };
    expect(sessionSchema.safeParse({ ...baseSession, perQuestionScores: [bad] }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...baseSession, roundType: "trivia" }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...baseSession, role: "staff-engineer" }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...baseSession, metricsVersion: 2 }).success).toBe(false);
  });

  it("rejects non-finite numbers (NaN/Infinity never reach the DB)", () => {
    expect(sessionSchema.safeParse({ ...baseSession, startedAt: Number.NaN }).success).toBe(false);
    expect(
      sessionSchema.safeParse({
        ...baseSession,
        latency: { perTurnMs: [Number.POSITIVE_INFINITY], avgMs: null },
      }).success,
    ).toBe(false);
  });
});
