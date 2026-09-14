import type { Difficulty, RoleFamily } from "@/lib/interview/roles";
import type { RolePreset, RubricEntry, RubricScores } from "@/lib/types";

// The adaptive interview's contracts. The application owns everything in here —
// plan, evidence, coverage, claims, timing, scores. The language model only ever
// sees a rendering of it (lib/interview/brief.ts) and proposes ONE move, which
// lib/interview/actions.ts validates before anything is said.

export const ACTIONS = [
  "follow_up",
  "clarify",
  "challenge",
  "probe_resume",
  "adjust_difficulty",
  "switch_competency",
  "test_contradiction",
  "wrap",
] as const;
export type ActionType = (typeof ACTIONS)[number];

export type InterviewPhase = "opening" | "assessing" | "coding" | "code-review" | "candidate-questions" | "closing" | "done";

export type InterviewStyle = "conversational-behavioural" | "technical-deep-dive";

export interface PlanCompetency {
  id: string;
  label: string;
  required: boolean;
  weight: number;
}

export interface InterviewPlan {
  role: RolePreset;
  family: RoleFamily;
  roleLabel: string;
  roundType: "hr" | "technical";
  candidate: { name: string; level: "fresher" | "experienced"; years?: number };
  resume: { skills: string[]; projects: string[]; companies: string[] } | null;
  jobDescription: { keywords: string[] } | null;
  competencies: PlanCompetency[];
  /** Ids of the claims (in state.claims) this interview sets out to verify. */
  claimsToVerify: string[];
  startingDifficulty: Difficulty;
  style: InterviewStyle;
  targetMinutes: number;
  /** Hard safety cap only — progress is driven by evidence coverage. */
  maxAnswers: number;
  coding: boolean;
}

// ——— one answer, deterministically read ———

export type AnswerQuality = "silent" | "tap-out" | "vague" | "adequate" | "strong";

export interface AnswerSignals {
  words: number;
  numbers: boolean;
  techTerms: string[];
  ownership: boolean;
  causal: boolean;
  example: boolean;
  hedges: number;
  absolute: boolean;
  code: boolean;
  question: boolean;
}

export type AnswerFlag = "overclaim" | "hedged" | "asked-question" | "code" | "off-topic";

export interface AnswerAnalysis {
  /** History index of the candidate entry. */
  index: number;
  text: string;
  quality: AnswerQuality;
  signals: AnswerSignals;
  specificity: number;
  /** Competencies this answer is evidence for, with credit weight 0–1. */
  credits: { id: string; weight: number }[];
  flags: AnswerFlag[];
  /** A short phrase from the answer worth referring back to ("Spring Boot"). */
  salient: string | null;
}

// ——— evidence and coverage ———

export interface EvidenceItem {
  turn: number;
  quote: string;
  quality: AnswerQuality;
  /** 0–10, or null when the answer carries no score (silence). */
  score: number | null;
  weight: number;
  source: "heuristic" | "model";
  note?: string;
}

export interface CompetencyLedger {
  id: string;
  coverage: number;
  /** Coverage contributed by evidence the per-competency cap has since dropped,
   * kept by kind so the vague and tap-out caps still hold after archiving. */
  archived: { solid: number; vague: number; tapOut: number };
  evidence: EvidenceItem[];
  difficulty: Difficulty;
  /** Interviewer turns spent on this competency. */
  turns: number;
  struggles: number;
  lastAdjustTurn: number;
  strength?: string;
  weakness?: string;
}

// ——— claims and contradictions ———

export type ClaimKind = "ownership" | "experience" | "skill" | "scope" | "negation" | "role" | "timeline";

export interface Claim {
  id: string;
  /** First-person statement minus the subject: "designed the backend architecture". */
  text: string;
  area: string;
  tech?: string;
  kind: ClaimKind;
  polarity: 1 | -1;
  exclusive?: boolean;
  role?: "lead" | "owner" | "builder" | "member";
  years?: number;
  recent?: boolean;
  source: "resume" | "answer" | "model";
  /** History index of the answer; -1 for the resume. */
  turn: number;
  /** Verbatim excerpt — always verifiable against the transcript (or resume). */
  quote: string;
  status: "unverified" | "supported" | "weak" | "contradicted";
  confidence: number;
  evidence: string[];
  probes: number;
  competency?: string;
}

export type ContradictionKind = "scope" | "polarity" | "role" | "timeline" | "resume";

export interface Contradiction {
  id: string;
  kind: ContradictionKind;
  /** Claim ids, earlier first. */
  a: string;
  b: string;
  textA: string;
  textB: string;
  quoteA: string;
  quoteB: string;
  turnA: number;
  turnB: number;
  status: "open" | "tested" | "resolved";
  explanation: string;
  source: "heuristic" | "model";
}

// ——— moves ———

export interface ProposedMove {
  action: ActionType;
  competency?: string;
  /** A claim id (probe_resume) or contradiction id (test_contradiction). */
  target?: string;
  direction?: "up" | "down";
  /** Verbatim words of the candidate that justify the move. */
  evidence?: string;
}

export interface MoveOption extends ProposedMove {
  reason: string;
}

export type MoveVerdict = { ok: true; move: ProposedMove } | { ok: false; reason: string };

/** What kind of turn the application has decided comes next. Only "move" turns
 * are the model's to shape; the rest are owned by the state machine. */
export type TurnKind = "open" | "move" | "coding" | "code-review" | "hand-over" | "answer-questions" | "close";

export interface ActionRecord {
  turn: number;
  kind: TurnKind;
  action?: ActionType;
  competency?: string;
  target?: string;
  source: "model" | "engine" | "fallback" | "observed";
  /** Why a proposed move was refused, when one was. */
  rejected?: string;
}

export interface ThreadState {
  competency: string | null;
  startTurn: number;
  question: string;
  followUps: number;
  clarifies: number;
  challenges: number;
  /** Candidate history indices answered inside this thread. */
  answers: number[];
}

export interface Struggle {
  turn: number;
  competency: string | null;
  question: string;
  kind: "silent" | "tap-out" | "vague";
}

/** Legacy per-question rubric, kept so the scorecard, history dots and progress
 * chart keep working — one entry per competency thread. */
export interface ThreadScore {
  id: number;
  competency: string | null;
  question: string;
  answers: number[];
  entry: RubricEntry | null;
  source: "model" | "heuristic";
}

export interface InterviewState {
  v: 1;
  sid: string;
  /** Monotonic id counter for claims and contradictions. */
  seq: number;
  createdAt: number;
  updatedAt: number;
  plan: InterviewPlan;
  phase: InterviewPhase;
  /** Interviewer turns produced or observed. */
  turn: number;
  /** Substantive candidate answers (silence excluded). */
  answers: number;
  /** History entries already ingested. */
  historyLen: number;
  historyHash: string;
  thread: ThreadState;
  ledger: Record<string, CompetencyLedger>;
  claims: Claim[];
  contradictions: Contradiction[];
  actions: ActionRecord[];
  asked: string[];
  struggles: Struggle[];
  /** Private interviewer notes proposed by the model. Context only — never scores. */
  notes: string[];
  threads: ThreadScore[];
  coding: { askedTurn: number | null; submittedIdx: number | null };
  handOverTurn: number | null;
  /** Candidate history indices the background model has analysed. */
  modelAnalyzed: number[];
}

export interface TurnDecision {
  kind: TurnKind;
  last: AnswerAnalysis | null;
  recommended: ProposedMove | null;
  options: MoveOption[];
  capReason: string | null;
  candidateAsked: boolean;
}

// ——— what the room is allowed to see ———

export type CoverageStatus = "not-started" | "in-progress" | "covered" | "struggling";

export interface InterviewView {
  phase: InterviewPhase;
  roleLabel: string;
  roundType: "hr" | "technical";
  current: string | null;
  difficulty: string;
  /** 0–1 progress toward minimum coverage of every required competency. */
  progress: number;
  competencies: { id: string; label: string; required: boolean; coverage: number; status: CoverageStatus }[];
  claims: { total: number; supported: number; contradicted: number };
  openContradictions: number;
  scoring: "model" | "heuristic";
}

// ——— background model analysis (one call per turn) ———

export interface ModelAnswerAnalysis {
  index: number;
  competencies: { id: string; score: number; quality: AnswerQuality; quote: string; strength?: string; weakness?: string }[];
  rubric: {
    scores: RubricScores;
    evidence: Partial<Record<keyof RubricScores, string>>;
    tips: Partial<Record<keyof RubricScores, string>>;
  } | null;
  claims: { text: string; area: string; kind: ClaimKind; polarity: 1 | -1; quote: string }[];
  contradictions: { claimId: string; quote: string; explanation: string }[];
  incorrect: string | null;
}

// ——— the readiness report ———

export type Verdict = "READY" | "ALMOST READY" | "NEEDS PRACTICE" | "NOT READY";

export interface CompetencyReport {
  id: string;
  label: string;
  required: boolean;
  /** 0–10, null when there was not enough verified evidence to score. */
  score: number | null;
  coverage: number;
  confidence: number;
  status: "assessed" | "not-assessed";
  evidence: string[];
  strength?: string;
  weakness?: string;
}

export interface ReadinessReport {
  version: 1;
  verdict: Verdict;
  overall: number | null;
  confidence: number;
  summary: string;
  role: string;
  roleLabel: string;
  roundType: "hr" | "technical";
  competencies: CompetencyReport[];
  strongest: string[];
  weakest: string[];
  struggled: { question: string; competency: string | null; kind: string; quote?: string }[];
  resumeFindings: { claim: string; status: string; detail: string; quote?: string }[];
  contradictions: { earlier: string; later: string; turnEarlier: number; turnLater: number; status: string; explanation: string }[];
  studyTopics: string[];
  practicePlan: string[];
  nextFocus: string[];
  generatedAt: number;
}
