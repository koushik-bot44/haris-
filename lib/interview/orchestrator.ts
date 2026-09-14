import { randomUUID } from "node:crypto";
import { validateMove } from "@/lib/interview/actions";
import { buildBrief, objectiveLine } from "@/lib/interview/brief";
import { commit, decide, ingest, initState, moveContext, viewOf } from "@/lib/interview/engine";
import { fallbackText } from "@/lib/interview/fallback";
import { buildReadinessReport } from "@/lib/interview/report";
import { historyHash, signState, verifyState } from "@/lib/interview/token";
import type { InterviewState, InterviewView, ProposedMove, ReadinessReport, TurnDecision } from "@/lib/interview/types";
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
  wasAlreadyAsked,
} from "@/lib/memory";
import type { AdaptiveLLMProvider } from "@/lib/llm/provider";
import { stripSpeechTags } from "@/lib/speakable";
import type { InterviewerTurn, InterviewerTurnType, InterviewRequest } from "@/lib/types";

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
// Cost: exactly one interviewer call per turn on the happy path. No background
// call is added here — per-answer rubric scoring keeps its existing single
// background call (/api/score), so a turn never spends more than it did before.

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
}

const CODING_LEAD_INS = [
  CODING_INTRO,
  "Let's switch gears and get you writing something. The editor is open — talk me through your thinking in comments if you like, and submit when you're happy with it.",
  "Good — now let's see some code. Use the editor, comment as much or as little as you want, and submit when ready.",
];

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

async function produce(req: InterviewRequest, s: InterviewState, d: TurnDecision, recall: string, opts: AdaptiveTurnOptions): Promise<Produced> {
  const lastQuestion = [...req.history].reverse().find((h) => h.speaker === "interviewer")?.text ?? "";
  if (d.kind === "coding") {
    const seed = codingSeedFrom(req.candidateName, req.history);
    const problem = codingQuestionFor(req.role, req.codeLanguage, seed);
    return { text: `${CODING_LEAD_INS[hashIndex(seed, CODING_LEAD_INS.length)]} ${problem.text}`, move: null, note: null, source: "engine" };
  }
  const fallback = (move: ProposedMove | null, rejected?: string): Produced => ({
    text: fallbackText({ state: s, decision: d, move, candidateName: req.candidateName, profile: req.profile, lastQuestion }),
    move,
    note: null,
    source: "fallback",
    ...(rejected ? { rejected } : {}),
  });
  const brief = buildBrief(s, d);
  const objective = objectiveLine(s, d);
  const ctx = moveContext(s, req.history, d.last, opts.now);
  let rejected: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const forcedMove = attempt === 1 && d.kind === "move" ? d.recommended : null;
    let out;
    try {
      out = await opts.provider.generate({ req, kind: d.kind, brief, objective, recall, forcedMove, signal: opts.signal });
    } catch (err) {
      console.warn(`[interview] model turn failed, the deterministic interviewer speaks — ${err instanceof Error ? err.message : String(err)}`);
      return fallback(d.recommended, rejected);
    }
    if (!out) return fallback(d.recommended, rejected);
    const clean = stripSpeechTags(out.text).trim();
    const question = extractQuestion(clean);
    if (!clean) {
      rejected = "empty reply";
      continue;
    }
    if (d.kind !== "open" && clean.includes("?") && question && wasAlreadyAsked(question, s.asked)) {
      rejected = "repeated a question already asked";
      continue;
    }
    if (d.kind !== "move") return { text: out.text, move: null, note: out.note, source: "model" };
    if (forcedMove) return { text: out.text, move: forcedMove, note: out.note, source: "model", ...(rejected ? { rejected } : {}) };
    const verdict = validateMove(out.move ?? d.recommended, ctx);
    if (verdict.ok) {
      return { text: out.text, move: verdict.move, note: out.note, source: "model", ...(out.move ? {} : { rejected: "no move line — recommended move assumed" }) };
    }
    rejected = verdict.reason;
    console.warn(`[interview] proposed move refused (${verdict.reason}) — regenerating with the recommended move`);
  }
  return fallback(d.recommended, rejected);
}

export async function runAdaptiveTurn(req: InterviewRequest, opts: AdaptiveTurnOptions): Promise<AdaptiveTurnResult> {
  const { now } = opts;
  const loaded = loadState(req, now);
  const { state: ingested, analyses } = ingest(loaded, req.history, now);
  const last = analyses[analyses.length - 1] ?? null;
  const decision = decide(ingested, req.history, last, now);

  // Long-term memory: primed at session start, read from cache afterwards —
  // never awaited on the turn path.
  const subject = opts.memoryKey?.trim() ?? "";
  let recall = "";
  if (subject) {
    if (req.history.length === 0) primeCandidateMemory({ subject, roundType: req.roundType, candidateName: req.candidateName });
    const facts = peekRecalledFacts(subject);
    const asked = peekAskedQuestions(subject, req.roundType);
    if (facts === null || asked === null) primeCandidateMemory({ subject, roundType: req.roundType, candidateName: req.candidateName, query: recallQuery(req.history) });
    recall = [recallBlock(facts ?? []), askedQuestionsBlock(asked ?? [])].filter(Boolean).join("\n");
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
  };
}
