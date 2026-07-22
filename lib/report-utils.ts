import type { RoundType, RubricScores, Session, Turn } from "@/lib/types";
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
  sessionId: string;
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
          sessionId: latest._id,
        };
      }
    }
  }
  return worst;
}

// ——— Report page + replay helpers ———

export function roundLabel(roundType: RoundType): string {
  return roundType === "technical" ? "Technical" : roundType === "gd" ? "Group Discussion" : "HR";
}

/** First names only — matches the live room's caption voice. */
const SPEAKER_FALLBACK: Record<RoundType, string> = { hr: "Haris", technical: "Haris", gd: "Speaker" };

/** Timeline label: the recorded persona, else the round's default persona. */
export function speakerName(turn: Turn, roundType: RoundType): string {
  if (turn.speaker === "candidate") return "You";
  return turn.personaName ?? SPEAKER_FALLBACK[roundType];
}

/** Replay axis: [session start → last turn end]. Empty transcript collapses to a point. */
export function sessionBounds(session: Session): { start: number; end: number } {
  const start =
    session.turns.length > 0 ? Math.min(session.startedAt, session.turns[0].tStart) : session.startedAt;
  const end = session.turns.reduce((m, t) => Math.max(m, t.tEnd), start);
  return { start, end };
}

/** "2:41" — turn-level precision only, never sub-second. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The turn "active" at absolute time t: the last turn started at or before t. */
export function activeTurnIndex(turns: Turn[], t: number): number {
  let idx = -1;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].tStart <= t) idx = i;
  }
  return idx;
}

/** History "incomplete (n/N)": N comes from the session itself, not a constant. */
export function questionDenominator(session: Session): number {
  const maxQ = session.perQuestionScores.reduce((m, e) => Math.max(m, e.questionId), 0);
  return Math.max(maxQ, session.perQuestionScores.length);
}

export interface AirtimeRow {
  id: string;
  label: string;
  pct: number;
  isCandidate: boolean;
}

/** GD panel rows: candidate first (from the pinned airtimeSharePct), personas
 * by share, labeled from the turns they spoke. Pure gdMetrics — no fetches. */
export function gdAirtimeRows(session: Session): AirtimeRow[] {
  const m = session.gdMetrics;
  if (!m) return [];
  const personaMs = Object.values(m.personaAirtimeMs).reduce((a, b) => a + b, 0);
  const total = m.candidateAirtimeMs + personaMs;
  if (total <= 0) return [];
  const nameById = new Map<string, string>();
  for (const t of session.turns) {
    if (t.personaId && t.personaName) nameById.set(t.personaId, t.personaName);
  }
  const rows: AirtimeRow[] = [
    { id: "candidate", label: "You", pct: Math.round(m.airtimeSharePct), isCandidate: true },
  ];
  const personas = Object.entries(m.personaAirtimeMs)
    .map(([id, ms]) => ({
      id,
      label: nameById.get(id) ?? id,
      pct: Math.round((ms / total) * 100),
      isCandidate: false,
    }))
    .sort((a, b) => b.pct - a.pct);
  return rows.concat(personas);
}
