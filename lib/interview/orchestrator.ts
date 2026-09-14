import { randomUUID } from "node:crypto";
import { alternativeMove, validateMove } from "@/lib/interview/actions";
import { alreadyAnswered, isSameQuestion } from "@/lib/interview/dedupe";
import { sanitizeForVoice, type VoiceEngineKind } from "@/lib/expressions";
import { buildBrief, objectiveLine } from "@/lib/interview/brief";
import { commit, decide, ingest, initState, mergeModelAnalysis, moveContext, viewOf } from "@/lib/interview/engine";
import { fallbackText } from "@/lib/interview/fallback";
import { buildReadinessReport } from "@/lib/interview/report";
import { historyHash, signState, verifyState } from "@/lib/interview/token";
import type { ActionType, InterviewState, InterviewView, ProposedMove, ReadinessReport, TurnDecision } from "@/lib/interview/types";
import { CODING_INTRO, codingQuestionFor, codingSeedFrom } from "@/lib/fixtures/technical-questions";
import {
  askedQuestionsBlock,
  extractQuestion,
  latestAnswer,
  peekAskedQuestions,
  peekRecalledFacts,
  primeCandidateMemory,
  recallBlock,
  recallQuery,
  rememberAnswer,
  rememberAskedQuestion,
} from "@/lib/memory";
import { isNoAnswer } from "@/lib/llm/parse";
import { analyzeAnswers, pendingAnswers } from "@/lib/llm/analyze";
import type { AdaptiveLLMProvider } from "@/lib/llm/provider";
import { stripSpeechTags } from "@/lib/speakable";
import type { HistoryEntry, InterviewerTurn, InterviewerTurnType, InterviewRequest, RubricEntry } from "@/lib/types";

// One adaptive interviewer turn, end to end:
//
//   verified state (or rebuilt from the transcript)
//     → ingest the new answer: evidence, coverage, claims, contradictions
//     → decide the turn kind; for a move turn, the valid options + recommendation
//     → the model writes the words and proposes ONE move
//     → the move is validated (and the question checked for repetition)
//         invalid → one regeneration with the recommended move decided
//         no model / failure → the deterministic interviewer executes the move
//     → commit, sign, return turn + state + view (+ report when the round ends)
//
// Cost: one interviewer call per turn on the happy path, plus at most one small
// background-model call (lib/llm/analyze.ts) that assesses the newest answers.
// That call replaces the client's separate /api/score request, so a turn never
// spends more than it did before, and it runs in parallel so it adds no latency.

export interface AdaptiveTurnOptions {
  provider: AdaptiveLLMProvider;
  signal?: AbortSignal;
  memoryKey?: string | null;
  speculative?: boolean;
  now: number;
}

export interface AdaptiveTurnResult {
  turn: InterviewerTurn;
  state: string;
  view: InterviewView;
  report: ReadinessReport | null;
  /** Per-thread rubric entries for the scorecard, computed on the server. */
  scores: RubricEntry[];
}

const CODING_LEAD_INS = [
  CODING_INTRO,
  "Let's switch gears and get you writing something. The editor is open — talk me through your thinking in comments if you like, and submit when you're happy with it.",
  "Good — now let's see some code. Use the editor, comment as much or as little as you want, and submit when ready.",
];

/** How long a turn may wait, in total, for the background assessment; and the
 * least it waits after the interviewer's words are ready. A late result is not
 * lost — those answers stay pending and are assessed on the next turn. */
const ANALYSIS_BUDGET_MS = 5_000;
const ANALYSIS_GRACE_MS = 600;

function waitAtMost<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function hashIndex(seed: string, mod: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % mod;
}

/** Trust the client's state only when it is signed, fresh, for this role, and
 * bound to a prefix of this exact transcript. Otherwise rebuild it — never
 * adopt a score or coverage number the server cannot vouch for. */
function loadState(req: InterviewRequest, now: number): InterviewState {
  const verified = verifyState(req.state, now);
  if (
    verified &&
    verified.plan.role === req.role &&
    verified.historyLen <= req.history.length &&
    historyHash(req.history, verified.historyLen) === verified.historyHash
  ) {
    return verified;
  }
  if (req.state && req.history.length > 0) console.warn("[interview] state token not usable for this transcript — rebuilding from history");
  return initState({
    sid: verified?.sid ?? randomUUID(),
    now: verified?.createdAt ?? now,
    role: req.role,
    roundType: req.roundType,
    candidateName: req.candidateName,
    profile: req.profile,
    jobDescription: req.jobDescription,
  });
}

function turnType(d: TurnDecision, move: ProposedMove | null): InterviewerTurnType {
  switch (d.kind) {
    case "open":
      return "greeting";
    case "close":
      return "wrapup";
    case "answer-questions":
      return "reply";
    case "code-review":
      return "followup";
    case "coding":
    case "hand-over":
      return "question";
    case "move":
      return move && ["follow_up", "clarify", "challenge", "adjust_difficulty"].includes(move.action) ? "followup" : "question";
  }
}

interface Produced {
  text: string;
  move: ProposedMove | null;
  note: string | null;
  source: "model" | "engine" | "fallback";
  rejected?: string;
}

/** Moves that ask for more on known ground — the ones a memory check applies to. */
const PROBING: readonly ActionType[] = ["follow_up", "clarify", "probe_resume", "adjust_difficulty", "switch_competency"];

function recentAnswers(history: readonly HistoryEntry[], n: number): string[] {
  return history
    .filter((h) => h.speaker === "candidate" && !isNoAnswer(h.text) && !h.text.trim().startsWith("```"))
    .slice(-n)
    .map((h) => h.text);
}

async function produce(req: InterviewRequest, s: InterviewState, d: TurnDecision, recall: string, opts: AdaptiveTurnOptions): Promise<Produced> {
  const lastQuestion = [...req.history].reverse().find((h) => h.speaker === "interviewer")?.text ?? "";
  // The WHOLE round, not a window: live run turn 8 re-asked "why you chose
  // Spring Boot" because that answer had aged out of a six-answer window.
  const answers = recentAnswers(req.history, 40);
  const engine: VoiceEngineKind = req.voiceEngine ?? "kokoro";
  if (d.kind === "coding") {
    const seed = codingSeedFrom(req.candidateName, req.history);
    const problem = codingQuestionFor(req.role, req.codeLanguage, seed);
    return { text: `${CODING_LEAD_INS[hashIndex(seed, CODING_LEAD_INS.length)]} ${problem.text}`, move: null, note: null, source: "engine" };
  }
  const fallback = (move: ProposedMove | null, rejected?: string): Produced => ({
    text: fallbackText({ state: s, decision: d, move, candidateName: req.candidateName, profile: req.profile, lastQuestion, answers, engine }),
    move,
    note: null,
    source: "fallback",
    ...(rejected ? { rejected } : {}),
  });
  const objective = objectiveLine(s, d);
  const ctx = moveContext(s, req.history, d.last, opts.now);
  let rejected: string | undefined;
  const avoid: string[] = [];
  /** The move the retry must execute — a DIFFERENT one when the first attempt
   * repeated itself, or the recommended one when its move was refused. */
  let retryMove: ProposedMove | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const forcedMove = attempt === 1 && d.kind === "move" ? (retryMove ?? d.recommended) : null;
    const brief = buildBrief(s, d, { avoid });
    let out;
    try {
      out = await opts.provider.generate({ req, kind: d.kind, brief, objective, recall, forcedMove, signal: opts.signal });
    } catch (err) {
      console.warn(`[interview] model turn failed, the deterministic interviewer speaks — ${err instanceof Error ? err.message : String(err)}`);
      return fallback(d.recommended, rejected);
    }
    if (!out) return fallback(retryMove ?? d.recommended, rejected);
    const spoken = sanitizeForVoice(out.text, engine);
    const clean = stripSpeechTags(spoken).trim();
    const question = extractQuestion(clean);
    if (!clean) {
      rejected = "empty reply";
      continue;
    }
    const proposedAction = (out.move as { action?: unknown } | null)?.action;
    const action = typeof proposedAction === "string" ? proposedAction : (d.recommended?.action ?? null);
    // Interview memory, applied to the model's words before they are spoken.
    if (d.kind !== "open" && question && isSameQuestion(question, s.asked)) {
      rejected = "repeated a question already asked";
      avoid.push(`You asked "${question.slice(0, 140)}" — that was already asked. Ask for something new.`);
      retryMove = d.kind === "move" ? alternativeMove(ctx, [action as ActionType]) : null;
      console.warn(`[interview] rejected a repeated question — regenerating${retryMove ? ` with ${retryMove.action}` : ""}`);
      continue;
    }
    if (d.kind === "move" && question && (!action || PROBING.includes(action as ActionType))) {
      const covered = alreadyAnswered(question, answers);
      if (covered) {
        rejected = "asked something they already answered";
        avoid.push(`"${question.slice(0, 140)}" is already answered — they said: "${covered.slice(0, 160)}". Ask only about what they have NOT said.`);
        retryMove = alternativeMove(ctx, [action as ActionType]);
        console.warn(`[interview] rejected an already-answered question — regenerating${retryMove ? ` with ${retryMove.action}` : ""}`);
        continue;
      }
    }
    if (d.kind !== "move") return { text: spoken, move: null, note: out.note, source: "model" };
    if (forcedMove) return { text: spoken, move: forcedMove, note: out.note, source: "model", ...(rejected ? { rejected } : {}) };
    const verdict = validateMove(out.move ?? d.recommended, ctx);
    if (verdict.ok) {
      return { text: spoken, move: verdict.move, note: out.note, source: "model", ...(out.move ? {} : { rejected: "no move line — recommended move assumed" }) };
    }
    rejected = verdict.reason;
    retryMove = null;
    console.warn(`[interview] proposed move refused (${verdict.reason}) — regenerating with the recommended move`);
  }
  return fallback(retryMove ?? d.recommended, rejected);
}

export async function runAdaptiveTurn(req: InterviewRequest, opts: AdaptiveTurnOptions): Promise<AdaptiveTurnResult> {
  const { now } = opts;
  const loaded = loadState(req, now);
  const { state: ingested, analyses } = ingest(loaded, req.history, now);
  const last = analyses[analyses.length - 1] ?? null;
  const decision = decide(ingested, req.history, last, now);

  // The one background call this turn may spend, started now so it runs in
  // parallel with the interviewer's. Never on a speculative pre-fetch.
  const started = Date.now();
  const batch = opts.speculative ? [] : pendingAnswers(ingested, req.history);
  const assessment = batch.length
    ? analyzeAnswers(ingested, req.history, batch).catch((err) => {
        console.warn(`[interview] background assessment failed, keeping the deterministic reading — ${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
    : Promise.resolve(null);

  // Long-term memory: primed at session start, read from cache afterwards —
  // never awaited on the turn path.
  const subject = opts.memoryKey?.trim() ?? "";
  let recall = "";
  if (subject) {
    if (req.history.length === 0) primeCandidateMemory({ subject, roundType: req.roundType, candidateName: req.candidateName });
    const facts = peekRecalledFacts(subject);
    const asked = peekAskedQuestions(subject, req.roundType);
    if (facts === null || asked === null) primeCandidateMemory({ subject, roundType: req.roundType, candidateName: req.candidateName, query: recallQuery(req.history) });
    // Cross-session questions only: this session's own are in the brief.
    const crossSession = (asked ?? []).filter((q) => !isSameQuestion(q, ingested.asked));
    recall = [recallBlock(facts ?? []), askedQuestionsBlock(crossSession)].filter(Boolean).join("\n");
    const answer = latestAnswer(req.history);
    if (answer && !opts.speculative) rememberAnswer(subject, req.roundType, answer, req.candidateName);
  }

  const produced = await produce(req, ingested, decision, recall, opts);
  const clean = stripSpeechTags(produced.text).trim();
  let state = commit(
    ingested,
    {
      kind: decision.kind,
      move: produced.move,
      text: clean,
      source: produced.source,
      ...(produced.rejected ? { rejected: produced.rejected } : {}),
      ...(produced.note ? { note: produced.note } : {}),
    },
    now,
  );
  state = { ...state, historyLen: req.history.length, historyHash: historyHash(req.history) };
  const assessed = await waitAtMost(assessment, Math.max(ANALYSIS_GRACE_MS, ANALYSIS_BUDGET_MS - (Date.now() - started)));
  if (assessed?.length) state = mergeModelAnalysis(state, assessed, req.history, now);

  const done = decision.kind === "close";
  const pos = state.threads.findIndex((t) => t.id === state.thread.startTurn);
  const type = turnType(decision, produced.move);
  const questionIndex = type === "greeting" || type === "wrapup" || type === "reply" ? 0 : Math.min(20, pos >= 0 ? pos + 1 : state.threads.length + 1);
  const turn: InterviewerTurn = {
    type,
    text: produced.text,
    questionIndex,
    done,
    asked: decision.kind === "coding" || clean.includes("?"),
    ...(decision.kind === "coding" ? { coding: true } : {}),
    ...(produced.source === "fallback" ? { scripted: true } : {}),
  };

  if (subject && !opts.speculative && turn.asked && decision.kind !== "open") {
    rememberAskedQuestion(subject, req.roundType, decision.kind === "coding" ? codingQuestionFor(req.role, req.codeLanguage, codingSeedFrom(req.candidateName, req.history)).text : clean, req.candidateName);
  }

  return {
    turn,
    state: signState(state),
    view: viewOf(state),
    report: done ? buildReadinessReport(state, req.history, now) : null,
    scores: state.threads.map((t) => t.entry).filter((e): e is RubricEntry => Boolean(e)),
  };
}
