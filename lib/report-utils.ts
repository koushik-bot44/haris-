import type { RubricScores, Session } from "@/lib/types";
import { avgScore, type Criterion } from "@/lib/rubric";

// Pure selectors behind the three reporting views (one data surface, three
// jobs — binding UX spec). All read the same Session[] the guest store holds.

export const CRITERIA: Criterion[] = ["relevance", "structure", "depth", "communication"];

export const CRITERION_LABEL: Record<Criterion, string> = {
  relevance: "Relevance",
  structure: "Structure",
  depth: "Depth",
  communication: "Communication",
};

export function scoredSessions(sessions: Session[]): Session[] {
  return sessions
    .filter((s) => s.perQuestionScores.length > 0)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** History rows: per-question average as dots (1–5 rounded). */
export function scoreDots(session: Session): number[] {
  return session.perQuestionScores.map((e) => Math.round(avgScore(e.scores)));
}

export function sessionAvg(session: Session): number | null {
  if (session.perQuestionScores.length === 0) return null;
  const a =
    session.perQuestionScores.reduce((acc, e) => acc + avgScore(e.scores), 0) /
    session.perQuestionScores.length;
  return Math.round(a * 10) / 10;
}

/** Progress view: per-criterion average per session, chronological. */
export function criterionTrend(sessions: Session[]): { t: number; scores: RubricScores }[] {
  return scoredSessions(sessions).map((s) => {
    const totals: RubricScores = { relevance: 0, structure: 0, depth: 0, communication: 0 };
    for (const e of s.perQuestionScores) {
      for (const c of CRITERIA) totals[c] += e.scores[c];
    }
    const n = s.perQuestionScores.length;
    return {
      t: s.startedAt,
      scores: {
        relevance: totals.relevance / n,
        structure: totals.structure / n,
        depth: totals.depth / n,
        communication: totals.communication / n,
      },
    };
  });
}

export interface FixFirst {
  criterion: Criterion;
  score: number;
  evidence?: string;
  tip?: string;
  question: string;
  sessionStartedAt: number;
}

/** Dashboard's single job: "what should I fix before my next interview" —
 * the weakest criterion of the LATEST scored session, with its evidence. */
export function latestWeakest(sessions: Session[]): FixFirst | null {
  const scored = scoredSessions(sessions);
  const latest = scored[scored.length - 1];
  if (!latest) return null;
  let worst: FixFirst | null = null;
  for (const e of latest.perQuestionScores) {
    for (const c of CRITERIA) {
      if (!worst || e.scores[c] < worst.score) {
        worst = {
          criterion: c,
          score: e.scores[c],
          evidence: e.evidence[c],
          tip: e.tips[c],
          question: e.question,
          sessionStartedAt: latest.startedAt,
        };
      }
    }
  }
  return worst;
}
