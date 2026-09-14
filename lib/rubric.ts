import { z } from "zod";
import type { RubricEntry, RubricScores, SessionScoring } from "@/lib/types";

// The rubric contract, its validation, and the evidence-quote verifier.
// The verifier is the project's thesis-protector: a hallucinated "quote from
// your own answer" is the most examiner-visible failure possible, so every
// quote is checked against the transcript — mismatches render WITHOUT a quote
// rather than with a fabricated one.

const CRITERIA = ["relevance", "structure", "depth", "communication"] as const;
export type Criterion = (typeof CRITERIA)[number];

const scoreValue = z.number().int().min(1).max(5);

export const rubricResponseSchema = z.object({
  scores: z.object({
    relevance: scoreValue,
    structure: scoreValue,
    depth: scoreValue,
    communication: scoreValue,
  }),
  evidence: z.object({
    relevance: z.string().max(300).optional(),
    structure: z.string().max(300).optional(),
    depth: z.string().max(300).optional(),
    communication: z.string().max(300).optional(),
  }),
  tips: z.object({
    relevance: z.string().max(200).optional(),
    structure: z.string().max(200).optional(),
    depth: z.string().max(200).optional(),
    communication: z.string().max(200).optional(),
  }),
});
export type RubricResponse = z.infer<typeof rubricResponseSchema>;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A quote is verified iff its normalized form appears in the normalized
 * transcript. ASR punctuation/casing differences are forgiven; different
 * words are not. */
export function verifyQuote(quote: string, transcript: string): boolean {
  const q = normalize(quote);
  if (q.length < 3) return false;
  return normalize(transcript).includes(q);
}

/** Drop every evidence quote that is not verbatim-present in the answer. */
export function verifyEvidence(
  resp: RubricResponse,
  answerTranscript: string,
): { evidence: Partial<Record<Criterion, string>>; dropped: Criterion[] } {
  const evidence: Partial<Record<Criterion, string>> = {};
  const dropped: Criterion[] = [];
  for (const c of CRITERIA) {
    const quote = resp.evidence[c];
    if (quote && verifyQuote(quote, answerTranscript)) evidence[c] = quote;
    else if (quote) dropped.push(c);
  }
  return { evidence, dropped };
}

export function toRubricEntry(
  questionId: number,
  question: string,
  answerTranscript: string,
  resp: RubricResponse,
): RubricEntry {
  const { evidence } = verifyEvidence(resp, answerTranscript);
  return { questionId, question, answerTranscript, scores: resp.scores, evidence, tips: resp.tips };
}

export function avgScore(scores: RubricScores): number {
  return (scores.relevance + scores.structure + scores.depth + scores.communication) / 4;
}

export function strongestCriterion(scores: RubricScores): Criterion {
  return [...CRITERIA].sort((a, b) => scores[b] - scores[a])[0];
}
export function weakestCriterion(scores: RubricScores): Criterion {
  return [...CRITERIA].sort((a, b) => scores[a] - scores[b])[0];
}

/** Coach-tone session summary composed from data (no extra LLM call):
 * one strength + one priority fix — never a list of failures. */
export function composeOverall(entries: RubricEntry[]): { avgScore: number | null; summary: string } {
  if (entries.length === 0) return { avgScore: null, summary: "No scored answers this round." };
  const avg = entries.reduce((a, e) => a + avgScore(e.scores), 0) / entries.length;
  const totals: Record<Criterion, number> = { relevance: 0, structure: 0, depth: 0, communication: 0 };
  for (const e of entries) for (const c of CRITERIA) totals[c] += e.scores[c];
  const LABEL: Record<Criterion, string> = {
    relevance: "staying on-point",
    structure: "structuring answers (situation → action → result)",
    depth: "backing claims with specifics",
    communication: "clear, confident delivery",
  };
  // Stable sorts with a deterministic tiebreak (CRITERIA order), and the
  // weakest is chosen from the criteria EXCLUDING the strongest, so a tie can
  // never name the same criterion as both strength and weakness.
  const byDesc = [...CRITERIA].sort((a, b) => totals[b] - totals[a] || CRITERIA.indexOf(a) - CRITERIA.indexOf(b));
  const strongest = byDesc[0];
  const rest = CRITERIA.filter((c) => c !== strongest);
  const weakest = [...rest].sort((a, b) => totals[a] - totals[b] || CRITERIA.indexOf(a) - CRITERIA.indexOf(b))[0];
  const even = totals[strongest] === totals[weakest];
  const rounded = Math.round(avg * 10) / 10;
  if (even) {
    return {
      avgScore: rounded,
      summary:
        rounded >= 4
          ? `Your scores were even across all four criteria, and strong. Next: pick one answer and add a concrete number or named example to push it from good to memorable.`
          : `Your scores were even across all four criteria. One thing to work on before the next interview: ${LABEL.depth} — a specific example lifts every other criterion with it.`,
    };
  }
  return {
    avgScore: rounded,
    summary: `Your strength this round: ${LABEL[strongest]}. One thing to work on before the next interview: ${LABEL[weakest]}.`,
  };
}

/** Why a round ended up with the scores it has (or none). */
export function scoringStatus(scored: number, tooShort: number, failed: number): SessionScoring {
  if (scored > 0) return { status: failed > 0 ? "partial" : "ok", failed };
  if (failed > 0) return { status: "unavailable", failed };
  if (tooShort > 0) return { status: "too_short", failed };
  return { status: "none", failed };
}

/** Short/empty answers are not scoreable — the plan's too-short gate. */
export const MIN_SCOREABLE_WORDS = 15;
export function isScoreable(answerTranscript: string): boolean {
  return answerTranscript.trim().split(/\s+/).filter(Boolean).length >= MIN_SCOREABLE_WORDS;
}
