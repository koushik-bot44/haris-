import { z } from "zod";
import type { Session } from "@/lib/types";

// Server-side validation of the full pinned Session shape (lib/types.ts).
// Strict objects reject junk keys — this endpoint stores what clients send, so
// the schema is the only thing standing between the DB and arbitrary payloads.
// Caps: turns ≤ 200, text fields ≤ 8000, perQuestionScores ≤ 20.

const TEXT_MAX = 8000;
const TURNS_MAX = 200;
const SCORES_MAX = 20;

const scoreValue = z.number().int().min(1).max(5);
const epochMs = z.number().finite().nonnegative();
const boundedText = z.string().max(TEXT_MAX);

const rubricScoresSchema = z
  .object({
    relevance: scoreValue,
    structure: scoreValue,
    depth: scoreValue,
    communication: scoreValue,
  })
  .strict();

const criterionNotes = z
  .object({
    relevance: z.string().max(TEXT_MAX).optional(),
    structure: z.string().max(TEXT_MAX).optional(),
    depth: z.string().max(TEXT_MAX).optional(),
    communication: z.string().max(TEXT_MAX).optional(),
  })
  .strict();

const turnSchema = z
  .object({
    speaker: z.enum(["interviewer", "candidate"]),
    text: boundedText,
    tStart: epochMs,
    tEnd: epochMs,
    personaId: z.string().max(60).optional(),
    personaName: z.string().max(120).optional(),
  })
  .strict();

const rubricEntrySchema = z
  .object({
    questionId: z.number().int().min(0).max(1000),
    question: boundedText,
    answerTranscript: boundedText,
    scores: rubricScoresSchema,
    evidence: criterionNotes,
    tips: criterionNotes,
  })
  .strict();

const deliveryMetricsSchema = z
  .object({
    wpm: z.number().finite().nonnegative(),
    fillerCount: z.number().int().nonnegative(),
    hesitationCount: z.number().int().nonnegative(),
    longestPauseMs: z.number().finite().nonnegative(),
  })
  .strict();

const gdMetricsSchema = z
  .object({
    airtimeSharePct: z.number().finite().min(0).max(100),
    interjections: z
      .array(z.object({ tMs: epochMs, builtOnPrevious: z.boolean() }).strict())
      .max(400),
    candidateTurns: z.number().int().nonnegative(),
    candidateAirtimeMs: epochMs,
    personaAirtimeMs: z.record(z.string().max(60), epochMs),
  })
  .strict();

const retryEntrySchema = z
  .object({
    questionId: z.number().int().min(0).max(1000),
    answerTranscript: boundedText,
    scores: rubricScoresSchema,
    at: epochMs,
  })
  .strict();

export const sessionSchema = z
  .object({
    _id: z.string().min(8).max(64),
    userId: z.string().max(200).nullable(),
    role: z.enum(["general", "java-sde-fresher", "frontend-fresher"]),
    roundType: z.enum(["hr", "technical", "gd"]),
    codingUsed: z.boolean(),
    startedAt: epochMs,
    turns: z.array(turnSchema).max(TURNS_MAX),
    perQuestionScores: z.array(rubricEntrySchema).max(SCORES_MAX),
    deliveryMetrics: deliveryMetricsSchema.nullable(),
    metricsVersion: z.literal(1),
    latency: z
      .object({
        perTurnMs: z.array(z.number().finite().nonnegative()).max(TURNS_MAX),
        avgMs: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
    overall: z
      .object({
        avgScore: z.number().finite().min(0).max(5).nullable(),
        summary: boundedText,
      })
      .strict(),
    gdMetrics: gdMetricsSchema.optional(),
    topic: z.string().max(500).optional(),
    retries: z.array(retryEntrySchema).max(SCORES_MAX * 3).optional(),
  })
  .strict();

/** Compile-time guarantee: the schema's output satisfies the pinned Session contract. */
export function toSession(parsed: z.infer<typeof sessionSchema>): Session {
  return parsed;
}
