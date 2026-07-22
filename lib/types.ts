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
  /** GD rounds: which AI persona spoke (absent on 1:1 turns and candidate turns). */
  personaId?: string;
  personaName?: string;
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
  /** GD sessions only. Optional so stored v1 payloads keep parsing. */
  gdMetrics?: GdMetrics;
  /** GD sessions: the discussion topic. */
  topic?: string;
  /** Append-only — originals never mutated (reserved for the retry feature). */
  retries?: RetryEntry[];
}

export interface RetryEntry {
  questionId: number;
  answerTranscript: string;
  scores: RubricScores;
  at: number;
}

// ——— Group Discussion (GD) contracts ———

export interface GdPersona {
  id: string;
  name: string;
  /** One-line behavioral style fed to the LLM ("interrupts, speaks in absolutes"). */
  style: string;
  /** Chatterbox voice file (e.g. "Axel.wav"); falls back per lib/voices.ts. */
  voice: string;
  /** Orb hue triple for this persona's visual identity. */
  hue: [number, number, number];
}

export interface GdInterjection {
  tMs: number; // ms since discussion start
  builtOnPrevious: boolean;
}

export interface GdMetrics {
  airtimeSharePct: number; // candidate share of total speaking time
  interjections: GdInterjection[];
  candidateTurns: number;
  candidateAirtimeMs: number;
  personaAirtimeMs: Record<string, number>;
}

/** personaId "candidate" = the student; anything else = an AI persona id. */
export interface GdHistoryEntry {
  personaId: string;
  text: string;
}

export interface GdTurn {
  personaId: string;
  text: string;
}

export interface GdRequest {
  topic: string;
  candidateName: string;
  history: GdHistoryEntry[];
  /** How many persona turns to return in one batch (call-budget control). */
  wantTurns: number;
}

// ——— Interviewer protocol (client ⇄ /api/interview ⇄ provider) ———

export type InterviewerTurnType = "greeting" | "question" | "followup" | "wrapup";

export interface InterviewerTurn {
  type: InterviewerTurnType;
  text: string;
  /** 1-based index of the main question this turn belongs to; 0 for greeting/wrapup. */
  questionIndex: number;
  done: boolean;
  /** This question is answered in the code editor, not by voice (technical round). */
  coding?: boolean;
}

export interface HistoryEntry {
  speaker: Speaker;
  text: string;
}

/** Extracted client-side from the resume text (deterministic, instant) so the
 * interviewer knows the candidate before the first word — name, experience
 * level, skills, and projects drive greeting, question choice, and HR style. */
export interface ResumeProfile {
  name?: string;
  /** true = has real work experience; flips HR to why-change/package/notice questions. */
  experienced: boolean;
  yearsOfExperience?: number;
  companies: string[];
  skills: string[];
  projects: { name: string; summary: string }[];
  education?: string;
  /** One specific resume line worth a genuine opening compliment. */
  highlight?: string;
}

export type CodeLanguage = "java" | "python" | "cpp" | "javascript" | "c";

export interface InterviewRequest {
  role: RolePreset;
  roundType: "hr" | "technical";
  candidateName: string;
  resume?: string;
  /** Present when a resume was provided — every question should anchor to it. */
  profile?: ResumeProfile;
  /** Candidate's chosen coding-round language (technical round). */
  codeLanguage?: CodeLanguage;
  history: HistoryEntry[];
}

// ——— STT event trace (recorded for metrics + saved as future test fixtures) ———

export type SttTraceEvent =
  | { kind: "start"; t: number }
  | { kind: "result"; t: number; text: string; isFinal: boolean }
  | { kind: "restart"; t: number } // engine auto-stop → wrapper restarted it
  | { kind: "error"; t: number; error: string }
  | { kind: "stop"; t: number };
