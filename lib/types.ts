// Core contracts — pinned in the approved plan. Changing a shape here changes
// the scorecard, the reporting views, and the metrics pipeline with it.

export type RoundType = "hr" | "technical" | "gd";
export type RolePreset = "general" | "java-sde-fresher" | "frontend-fresher";

export type Speaker = "interviewer" | "candidate";

export interface Turn {
  speaker: Speaker;
  text: string;
  tStart: number; // epoch ms
  tEnd: number;
}

// Rubric contract (scoring lands in M1 weekend 2 — the shape is already pinned).
export interface RubricScores {
  relevance: number;
  structure: number;
  depth: number;
  communication: number;
}
export interface RubricEntry {
  questionId: number;
  question: string;
  answerTranscript: string;
  scores: RubricScores;
  evidence: Partial<Record<keyof RubricScores, string>>;
  tips: Partial<Record<keyof RubricScores, string>>;
}

export interface DeliveryMetrics {
  wpm: number;
  fillerCount: number;
  hesitationCount: number; // pauses > threshold — vocalized "um" never reaches Chrome transcripts
  longestPauseMs: number;
}

export interface Session {
  _id: string;
  userId: string | null; // null = guest
  role: RolePreset;
  roundType: RoundType;
  codingUsed: boolean;
  startedAt: number;
  turns: Turn[];
  perQuestionScores: RubricEntry[];
  deliveryMetrics: DeliveryMetrics | null;
  metricsVersion: 1;
  latency: { perTurnMs: number[]; avgMs: number | null };
  overall: { avgScore: number | null; summary: string };
}

// ——— Interviewer protocol (client ⇄ /api/interview ⇄ provider) ———

export type InterviewerTurnType = "greeting" | "question" | "followup" | "wrapup";

export interface InterviewerTurn {
  type: InterviewerTurnType;
  text: string;
  /** 1-based index of the main question this turn belongs to; 0 for greeting/wrapup. */
  questionIndex: number;
  done: boolean;
}

export interface HistoryEntry {
  speaker: Speaker;
  text: string;
}

export interface InterviewRequest {
  role: RolePreset;
  roundType: "hr";
  candidateName: string;
  history: HistoryEntry[];
}

// ——— STT event trace (recorded for metrics + saved as future test fixtures) ———

export type SttTraceEvent =
  | { kind: "start"; t: number }
  | { kind: "result"; t: number; text: string; isFinal: boolean }
  | { kind: "restart"; t: number } // engine auto-stop → wrapper restarted it
  | { kind: "error"; t: number; error: string }
  | { kind: "stop"; t: number };
