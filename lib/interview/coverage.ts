import type { Difficulty } from "@/lib/interview/roles";
import type { AnswerQuality, CompetencyLedger, CoverageStatus, EvidenceItem, InterviewState } from "@/lib/interview/types";

// Evidence → coverage → score, per competency.
//
// COVERAGE is how much the interview knows about a competency, not how good the
// candidate is at it: a clear "I don't know" after a real probe tells you
// something, a vague non-answer tells you almost nothing. SCORE is the quality
// the verified evidence shows. Keeping them apart is what lets a weak candidate
// finish an interview (their weaknesses are covered) without a vague one being
// waved through (vagueness never adds up to coverage).

/** Coverage at which a competency counts as assessed — switching away and
 * wrapping up are both gated on this. */
export const MIN_COVERAGE = 0.6;
/** Coverage past which probing further is refused as redundant. */
export const SUFFICIENT_COVERAGE = 1.0;
const MAX_COVERAGE = 1.5;

const INCREMENT: Record<AnswerQuality, number> = { strong: 0.5, adequate: 0.35, vague: 0.12, "tap-out": 0.25, silent: 0 };
/** However many vague answers pile up, they never reach MIN_COVERAGE. */
const VAGUE_CAP = 0.3;
/** Tap-outs establish a limit, but a limit alone is not a full picture. */
const TAP_OUT_CAP = 0.5;
const MAX_EVIDENCE = 6;

export const QUALITY_SCORE: Record<AnswerQuality, number | null> = { strong: 8, adequate: 6, vague: 3.5, "tap-out": 2, silent: null };
const SOURCE_CONFIDENCE = { heuristic: 0.6, model: 1 } as const;

export function emptyLedger(id: string, difficulty: Difficulty): CompetencyLedger {
  return { id, coverage: 0, archived: { solid: 0, vague: 0, tapOut: 0 }, evidence: [], difficulty, turns: 0, struggles: 0, lastAdjustTurn: -99 };
}

function tally(items: EvidenceItem[]): CompetencyLedger["archived"] {
  const t = { solid: 0, vague: 0, tapOut: 0 };
  for (const it of items) {
    const inc = INCREMENT[it.quality] * it.weight;
    if (it.quality === "vague") t.vague += inc;
    else if (it.quality === "tap-out") t.tapOut += inc;
    else t.solid += inc;
  }
  return t;
}

function coverageFrom(items: EvidenceItem[], archived: CompetencyLedger["archived"]): number {
  const t = tally(items);
  return Math.min(
    MAX_COVERAGE,
    t.solid + archived.solid + Math.min(VAGUE_CAP, t.vague + archived.vague) + Math.min(TAP_OUT_CAP, t.tapOut + archived.tapOut),
  );
}

/** Least informative first: heuristic before model, vague/silent before
 * substantive, then oldest. */
function dropPriority(it: EvidenceItem): number {
  const q = { silent: 0, vague: 1, "tap-out": 2, adequate: 3, strong: 4 }[it.quality];
  return (it.source === "model" ? 10 : 0) + q;
}

/** Record one piece of evidence. Returns a new ledger — callers keep state
 * immutable so a rejected turn can be discarded wholesale. A model reading of
 * an answer supersedes the heuristic reading of the same answer; the reverse
 * never happens. */
export function addEvidence(ledger: CompetencyLedger, item: EvidenceItem): CompetencyLedger {
  const evidence = [...ledger.evidence];
  const sameTurn = evidence.findIndex((e) => e.turn === item.turn);
  if (sameTurn !== -1) {
    const prior = evidence[sameTurn];
    if (prior.source === "model" && item.source === "heuristic") return ledger;
    evidence.splice(sameTurn, 1);
  }
  evidence.push(item);
  const archived = { ...ledger.archived };
  while (evidence.length > MAX_EVIDENCE) {
    let worst = 0;
    for (let i = 1; i < evidence.length; i++) {
      if (dropPriority(evidence[i]) < dropPriority(evidence[worst])) worst = i;
    }
    const dropped = tally([evidence[worst]]);
    archived.solid += dropped.solid;
    archived.vague += dropped.vague;
    archived.tapOut += dropped.tapOut;
    evidence.splice(worst, 1);
  }
  const coverage = coverageFrom(evidence, archived);
  const strength = item.source === "model" && item.note && (item.score ?? 0) >= 6 ? item.note : ledger.strength;
  const weakness = item.source === "model" && item.note && (item.score ?? 10) < 6 ? item.note : ledger.weakness;
  const struggles = ledger.struggles + (sameTurn === -1 && (item.quality === "tap-out" || item.quality === "silent") && item.weight >= 1 ? 1 : 0);
  return { ...ledger, evidence, archived, coverage, strength, weakness, struggles };
}

/** Confidence-weighted score from verified evidence. null = nothing to score. */
export function scoreOf(ledger: CompetencyLedger): { score: number | null; confidence: number } {
  let sum = 0;
  let weights = 0;
  for (const it of ledger.evidence) {
    if (it.score === null) continue;
    const w = it.weight * SOURCE_CONFIDENCE[it.source];
    sum += it.score * w;
    weights += w;
  }
  if (weights === 0) return { score: null, confidence: 0 };
  return { score: Math.round((sum / weights) * 10) / 10, confidence: Math.min(1, Math.round((weights / 1.6) * 100) / 100) };
}

export function isCovered(ledger: CompetencyLedger | undefined): boolean {
  return Boolean(ledger && ledger.coverage >= MIN_COVERAGE);
}

export function isSufficient(ledger: CompetencyLedger | undefined): boolean {
  return Boolean(ledger && ledger.coverage >= SUFFICIENT_COVERAGE);
}

/** Enough is known to stop pursuing it: covered, or honestly exhausted —
 * repeated tap-outs or a long thread with evidence in it. Without the second
 * half a candidate who genuinely does not know something could never finish. */
export function isAssessed(ledger: CompetencyLedger | undefined): boolean {
  if (!ledger) return false;
  return isCovered(ledger) || ledger.struggles >= 2 || (ledger.turns >= 4 && ledger.evidence.length >= 2);
}

export function statusOf(ledger: CompetencyLedger | undefined): CoverageStatus {
  if (!ledger || ledger.evidence.length === 0) return "not-started";
  if (isCovered(ledger)) return "covered";
  if (ledger.struggles >= 2) return "struggling";
  return "in-progress";
}

/** 0–1: how close the required competencies are, together, to being assessed. */
export function requiredProgress(state: InterviewState): number {
  const required = state.plan.competencies.filter((c) => c.required);
  if (!required.length) return 1;
  let total = 0;
  for (const c of required) {
    const l = state.ledger[c.id];
    total += isAssessed(l) ? 1 : Math.min(1, (l?.coverage ?? 0) / MIN_COVERAGE);
  }
  return Math.round((total / required.length) * 100) / 100;
}

export function unassessedRequired(state: InterviewState): string[] {
  return state.plan.competencies.filter((c) => c.required && !isAssessed(state.ledger[c.id])).map((c) => c.id);
}
