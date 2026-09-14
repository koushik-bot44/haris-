import { allowedMoves, hardCapReason, recommendMove, type MoveContext } from "@/lib/interview/actions";
import { analyzeAnswer } from "@/lib/interview/analysis";
import { canonicalArea, detectContradictions, extractClaims } from "@/lib/interview/claims";
import { addEvidence, emptyLedger, isAssessed, QUALITY_SCORE, requiredProgress, scoreOf, statusOf } from "@/lib/interview/coverage";
import { createPlan, type PlanInput } from "@/lib/interview/plan";
import { DIFFICULTY_LABEL, type Difficulty } from "@/lib/interview/roles";
import type {
  AnswerAnalysis,
  Claim,
  Contradiction,
  InterviewState,
  InterviewView,
  ModelAnswerAnalysis,
  ProposedMove,
  ThreadScore,
  TurnDecision,
  TurnKind,
} from "@/lib/interview/types";
import { extractQuestion, questionKey } from "@/lib/memory";
import { isNoAnswer, looksLikeCandidateQuestion } from "@/lib/llm/parse";
import { verifyQuote } from "@/lib/rubric";
import type { HistoryEntry, RubricEntry, RubricScores } from "@/lib/types";

// The interview state machine. Pure: state in, state out, no clock or network
// of its own — the orchestrator passes `now` and owns every side effect.
//
//   ingest   — read the transcript tail the state has not seen yet: analyse each
//              answer, add evidence, extract claims, detect contradictions.
//   decide   — what kind of turn comes next, and (for a "move" turn) the valid
//              options plus the deterministic recommendation.
//   commit   — record the turn that was actually said.
//   merge    — fold the background model's verified analysis into the ledger.

const MAX_ACTIONS = 40;
const MAX_ASKED = 40;
const MAX_CLAIMS = 18;
const MAX_STRUGGLES = 12;
const MAX_NOTES = 6;
const MAX_THREADS = 20;
const CODING_MARKER = /editor is open|use the editor/i;

export function initState(input: PlanInput & { sid: string; now: number }): InterviewState {
  let seq = 1;
  const { plan, claims } = createPlan(input, () => `c${seq++}`);
  const ledger = Object.fromEntries(plan.competencies.map((c) => [c.id, emptyLedger(c.id, plan.startingDifficulty)]));
  return {
    v: 1,
    sid: input.sid,
    seq,
    createdAt: input.now,
    updatedAt: input.now,
    plan,
    phase: "opening",
    turn: 0,
    answers: 0,
    historyLen: 0,
    historyHash: "",
    thread: { competency: null, startTurn: 0, question: "", followUps: 0, clarifies: 0, challenges: 0, answers: [] },
    ledger,
    claims,
    contradictions: [],
    actions: [],
    asked: [],
    struggles: [],
    notes: [],
    threads: [],
    coding: { askedTurn: null, submittedIdx: null },
    handOverTurn: null,
    modelAnalyzed: [],
  };
}

function idGen(s: InterviewState): () => string {
  return () => `c${s.seq++}`;
}

function capFront<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

function startThread(s: InterviewState, competency: string | null, question: string): void {
  s.thread = { competency, startTurn: s.turn, question, followUps: 0, clarifies: 0, challenges: 0, answers: [] };
}

function openingCompetency(s: InterviewState): string | null {
  const ids = s.plan.competencies.map((c) => c.id);
  if (s.plan.roundType === "technical" && ids.includes("projects")) return "projects";
  if (ids.includes("communication")) return "communication";
  return ids[0] ?? null;
}

/** The sentence of an answer most worth quoting as evidence. */
function evidenceQuote(a: AnswerAnalysis): string {
  if (a.quality === "silent") return "";
  const text = a.text.replace(/\s+/g, " ").trim();
  if (a.signals.code) return text.slice(0, 160);
  const sentences = text.split(/(?<=[.!?])\s+/).filter((x) => x.length >= 12);
  if (!sentences.length) return text.slice(0, 160);
  const scored = sentences.map((x) => ({
    x,
    s: (/\d/.test(x) ? 2 : 0) + (a.signals.techTerms.some((t) => x.toLowerCase().includes(t)) ? 2 : 0) + (/\bi\b/i.test(x) ? 1 : 0) + Math.min(2, x.length / 80),
  }));
  scored.sort((p, q) => q.s - p.s);
  return scored[0].x.slice(0, 160);
}

// ——— legacy per-thread rubric (the scorecard and progress chart read it) ———

function clamp5(n: number): 1 | 2 | 3 | 4 | 5 {
  return Math.max(1, Math.min(5, Math.round(n))) as 1 | 2 | 3 | 4 | 5;
}

export function heuristicRubric(id: number, question: string, analyses: AnswerAnalysis[]): RubricEntry | null {
  const spoken = analyses.filter((a) => a.quality !== "silent");
  if (!spoken.length) return null;
  const base = (a: AnswerAnalysis) => ({ strong: 4.5, adequate: 3.5, vague: 2.2, "tap-out": 2, silent: 1 })[a.quality];
  const avg = (f: (a: AnswerAnalysis) => number) => spoken.reduce((t, a) => t + f(a), 0) / spoken.length;
  const scores: RubricScores = {
    relevance: clamp5(avg((a) => base(a) + (a.flags.includes("off-topic") ? -1 : 0))),
    structure: clamp5(avg((a) => base(a) - 0.5 + (a.signals.example ? 0.7 : 0) + (a.signals.causal ? 0.5 : 0))),
    depth: clamp5(avg((a) => base(a) - 0.8 + Math.min(1.5, a.specificity * 0.4))),
    communication: clamp5(avg((a) => base(a) + 0.3 - (a.signals.hedges >= 2 ? 0.8 : 0))),
  };
  const weakest = (Object.keys(scores) as (keyof RubricScores)[]).sort((a, b) => scores[a] - scores[b])[0];
  const TIPS: Record<keyof RubricScores, string> = {
    relevance: "Answer the exact question first, then add context.",
    structure: "Shape it as situation → what you did → result, so the listener can follow.",
    depth: "Add one concrete number, tool or decision to make the answer land.",
    communication: "Commit to your answer — fewer 'maybe' and 'I think', more 'I did'.",
  };
  return {
    questionId: id,
    question: question.slice(0, 1200),
    answerTranscript: spoken.map((a) => a.text).join(" ").slice(0, 8000),
    scores,
    evidence: {},
    tips: { [weakest]: TIPS[weakest] },
  };
}

function threadScoreFor(s: InterviewState): ThreadScore {
  const existing = s.threads.find((t) => t.id === s.thread.startTurn);
  if (existing) return existing;
  const created: ThreadScore = { id: s.thread.startTurn, competency: s.thread.competency, question: s.thread.question, answers: [], entry: null, source: "heuristic" };
  s.threads = capFront([...s.threads, created], MAX_THREADS);
  return created;
}

// ——— ingest ———

function lastMove(s: InterviewState) {
  return [...s.actions].reverse().find((a) => a.kind === "move");
}

function recordClaims(s: InterviewState, a: AnswerAnalysis): void {
  const fresh = extractClaims(a.text, { turn: a.index, nextId: idGen(s) });
  const added: Claim[] = [];
  for (const claim of fresh) {
    const dup = s.claims.find(
      (c) =>
        c.source !== "resume" &&
        c.kind === claim.kind &&
        c.area === claim.area &&
        c.tech === claim.tech &&
        c.polarity === claim.polarity &&
        Boolean(c.exclusive) === Boolean(claim.exclusive),
    );
    if (dup) {
      if (!dup.evidence.includes(claim.quote)) dup.evidence = [...dup.evidence, claim.quote].slice(-3);
      continue;
    }
    const competency = s.thread.competency ?? undefined;
    added.push({ ...claim, ...(competency ? { competency } : {}) });
  }
  if (!added.length) return;
  const opened = detectContradictions(added, s.claims, s.contradictions, idGen(s));
  s.claims = [...s.claims, ...added];
  for (const c of opened) {
    for (const id of [c.a, c.b]) {
      const claim = s.claims.find((x) => x.id === id);
      if (claim) claim.status = "contradicted";
    }
  }
  s.contradictions = [...s.contradictions, ...opened].slice(-8);
  if (s.claims.length > MAX_CLAIMS) {
    const involved = new Set(s.contradictions.flatMap((c) => [c.a, c.b]));
    const keep = new Set(s.plan.claimsToVerify);
    const removable = s.claims.filter((c) => c.source !== "resume" && !involved.has(c.id) && !keep.has(c.id) && c.status === "unverified");
    const drop = new Set(removable.slice(0, s.claims.length - MAX_CLAIMS).map((c) => c.id));
    s.claims = s.claims.filter((c) => !drop.has(c.id));
  }
}

function verifyClaims(s: InterviewState, a: AnswerAnalysis): void {
  const probe = lastMove(s);
  const probedId = probe?.action === "probe_resume" ? probe.target : undefined;
  const lower = a.text.toLowerCase();
  for (const claim of s.claims) {
    if (claim.status === "contradicted" || claim.turn === a.index) continue;
    const mentions =
      (claim.tech && a.signals.techTerms.some((t) => canonicalArea(t).tech === claim.tech || t === claim.tech)) ||
      (claim.area.startsWith("project:") && lower.includes(claim.area.slice("project:".length))) ||
      claim.id === probedId;
    if (!mentions) continue;
    if (a.quality === "strong" || (a.quality === "adequate" && claim.id === probedId)) {
      claim.status = "supported";
      claim.confidence = Math.min(1, claim.confidence + 0.3);
      const quote = evidenceQuote(a);
      if (quote && !claim.evidence.includes(quote)) claim.evidence = [...claim.evidence, quote].slice(-3);
    } else if (claim.id === probedId && ["vague", "tap-out", "silent"].includes(a.quality)) {
      claim.status = "weak";
      claim.confidence = Math.max(0, claim.confidence - 0.2);
    }
  }
}

function applyAnswer(s: InterviewState, a: AnswerAnalysis, question: string): void {
  if (a.quality !== "silent") s.answers++;
  s.thread.answers = [...s.thread.answers, a.index];
  const quote = evidenceQuote(a);
  for (const credit of a.credits) {
    const ledger = s.ledger[credit.id];
    if (!ledger) continue;
    s.ledger[credit.id] = addEvidence(ledger, {
      turn: a.index,
      quote,
      quality: a.quality,
      score: QUALITY_SCORE[a.quality],
      weight: credit.weight,
      source: "heuristic",
    });
  }
  if (a.quality === "silent" && s.thread.competency && s.ledger[s.thread.competency]) {
    // Silence is not evidence, but it is a struggle on the ground being assessed.
    const l = s.ledger[s.thread.competency];
    s.ledger[s.thread.competency] = { ...l, struggles: l.struggles + 1 };
  }
  const struggleKind = a.quality === "silent" || a.quality === "tap-out" ? a.quality : a.quality === "vague" && s.thread.clarifies >= 1 && !a.flags.includes("asked-question") ? "vague" : null;
  if (struggleKind) {
    s.struggles = capFront(
      [...s.struggles, { turn: a.index, competency: s.thread.competency, question: extractQuestion(question).slice(0, 220), kind: struggleKind }],
      MAX_STRUGGLES,
    );
  }
  if (a.quality !== "silent" && !a.flags.includes("asked-question")) {
    recordClaims(s, a);
    verifyClaims(s, a);
  }
}

/** Read every history entry the state has not seen. Interviewer lines the
 * server itself produced are recognised and skipped; any other interviewer line
 * (an accepted speculative turn, a client that predates the state token) is
 * observed so repetition and thread tracking still hold. */
/** Is this history line the turn the server itself committed last? It can only
 * be the first entry after what the state has already ingested. */
function isOwnLine(s: InterviewState, prevHistoryLen: number, index: number, text: string): boolean {
  if (index !== prevHistoryLen) return false;
  const last = s.actions[s.actions.length - 1];
  if (!last || last.source === "observed" || last.turn !== s.turn) return false;
  const said = questionKey(text);
  const recorded = questionKey(s.asked[s.asked.length - 1] ?? "");
  if (!recorded) return true;
  return said.includes(recorded.slice(0, 60)) || recorded.includes(said.slice(0, 60));
}

export function ingest(prev: InterviewState, history: HistoryEntry[], now: number): { state: InterviewState; analyses: AnswerAnalysis[] } {
  const s = structuredClone(prev);
  const analyses: AnswerAnalysis[] = [];
  for (let i = s.historyLen; i < history.length; i++) {
    const h = history[i];
    if (h.speaker === "interviewer") {
      if (!isOwnLine(s, prev.historyLen, i, h.text)) {
        // Not ours: count it and remember what it asked.
        s.turn++;
        const q = extractQuestion(h.text);
        if (q) s.asked = capFront([...s.asked, q], MAX_ASKED);
        s.actions = capFront([...s.actions, { turn: s.turn, kind: "move" as TurnKind, source: "observed" as const }], MAX_ACTIONS);
        if (CODING_MARKER.test(h.text) && s.coding.askedTurn === null) {
          s.coding.askedTurn = s.turn;
          s.phase = "coding";
        }
      }
      continue;
    }
    const question = [...history.slice(0, i)].reverse().find((x) => x.speaker === "interviewer")?.text ?? "";
    // A fenced answer after the editor opened is the coding submission.
    if (s.coding.askedTurn !== null && s.coding.submittedIdx === null && h.text.trim().startsWith("```")) {
      s.coding.submittedIdx = i;
      s.phase = "code-review";
      const ps = s.plan.competencies.find((c) => c.id === "problem-solving") ? "problem-solving" : s.thread.competency;
      startThread(s, ps, extractQuestion(question));
    }
    const a = analyzeAnswer(h.text, { index: i, question, threadCompetency: s.thread.competency, plan: s.plan });
    applyAnswer(s, a, question);
    const ts = threadScoreFor(s);
    ts.answers = [...ts.answers, i];
    if (ts.source === "heuristic") {
      const threadAnswers = ts.answers.map((idx) =>
        idx === i ? a : analyzeAnswer(history[idx]?.text ?? "", { index: idx, question, threadCompetency: ts.competency, plan: s.plan }),
      );
      ts.entry = heuristicRubric(ts.id, ts.question || extractQuestion(question), threadAnswers);
    }
    analyses.push(a);
  }
  s.historyLen = history.length;
  s.updatedAt = now;
  return { state: s, analyses };
}

// ——— decide ———

function codingReady(s: InterviewState): boolean {
  if (!s.plan.coding || s.coding.askedTurn !== null) return false;
  if (s.answers < 2) return false;
  const hasProjects = s.plan.competencies.some((c) => c.id === "projects");
  const projectsDone = !hasProjects || isAssessed(s.ledger.projects);
  const touched = s.plan.competencies.some((c) => c.id !== "projects" && c.id !== "problem-solving" && (s.ledger[c.id]?.evidence.length ?? 0) > 0);
  if (s.contradictions.some((c) => c.status === "open")) return s.answers >= 7;
  return (projectsDone && touched) || s.answers >= 6;
}

export function moveContext(s: InterviewState, history: HistoryEntry[], last: AnswerAnalysis | null, now: number): MoveContext {
  const recentAnswers = history
    .filter((h) => h.speaker === "candidate" && !isNoAnswer(h.text))
    .slice(-3)
    .map((h) => h.text);
  return { state: s, last, recentAnswers, now };
}

export function decide(s: InterviewState, history: HistoryEntry[], last: AnswerAnalysis | null, now: number): TurnDecision {
  const ctx = moveContext(s, history, last, now);
  const candidateAsked = Boolean(last && looksLikeCandidateQuestion(last.text));
  const base = { last, recommended: null, options: [], capReason: null, candidateAsked };
  if (history.length === 0 || s.turn === 0) return { ...base, kind: "open" };
  if (s.phase === "done" || s.phase === "closing") return { ...base, kind: "close" };
  const cap = hardCapReason(ctx);
  if (s.phase === "candidate-questions") {
    const exchanges = s.turn - (s.handOverTurn ?? s.turn);
    const saidNothing = !last || last.quality === "silent";
    if (candidateAsked && exchanges < 4 && !(cap && exchanges >= 2)) return { ...base, kind: "answer-questions" };
    if (!candidateAsked && !saidNothing && exchanges === 0 && last && last.signals.words > 12) return { ...base, kind: "answer-questions" };
    return { ...base, kind: "close", capReason: cap };
  }
  if (s.phase === "code-review" && s.coding.submittedIdx === history.length - 1) return { ...base, kind: "code-review" };
  if (codingReady(s) && !cap) return { ...base, kind: "coding" };
  if (cap) return { ...base, kind: "hand-over", capReason: cap };
  return { ...base, kind: "move", recommended: recommendMove(ctx), options: allowedMoves(ctx) };
}

// ——— commit ———

export interface TurnCommit {
  kind: TurnKind;
  move?: ProposedMove | null;
  text: string;
  source: "model" | "engine" | "fallback";
  rejected?: string;
  note?: string;
}

export function commit(prev: InterviewState, c: TurnCommit, now: number): InterviewState {
  const s = structuredClone(prev);
  s.turn++;
  s.updatedAt = now;
  const question = extractQuestion(c.text);
  s.actions = capFront(
    [
      ...s.actions,
      {
        turn: s.turn,
        kind: c.kind,
        source: c.source,
        ...(c.move?.action ? { action: c.move.action } : {}),
        ...(c.move?.competency ? { competency: c.move.competency } : {}),
        ...(c.move?.target ? { target: c.move.target } : {}),
        ...(c.rejected ? { rejected: c.rejected.slice(0, 120) } : {}),
      },
    ],
    MAX_ACTIONS,
  );
  // Always recorded — even a turn with no "?" — so ingest can recognise the
  // line as ours when it comes back in the next request's history.
  s.asked = capFront([...s.asked, question || c.text.slice(0, 160)], MAX_ASKED);
  if (c.note?.trim()) s.notes = capFront([...s.notes, c.note.trim().slice(0, 160)], MAX_NOTES);

  switch (c.kind) {
    case "open":
      s.phase = "assessing";
      startThread(s, openingCompetency(s), question);
      break;
    case "coding":
      s.phase = "coding";
      s.coding.askedTurn = s.turn;
      startThread(s, s.plan.competencies.some((x) => x.id === "problem-solving") ? "problem-solving" : s.thread.competency, question);
      break;
    case "code-review":
      s.phase = "code-review";
      s.thread.followUps++;
      break;
    case "hand-over":
      s.phase = "candidate-questions";
      s.handOverTurn = s.turn;
      startThread(s, null, question);
      break;
    case "answer-questions":
      break;
    case "close":
      s.phase = "done";
      break;
    case "move":
      if (c.move) applyMove(s, c.move, question);
      if (s.phase === "code-review" && c.move?.action === "switch_competency") s.phase = "assessing";
      break;
  }
  const comp = s.thread.competency;
  if (comp && s.ledger[comp]) s.ledger[comp] = { ...s.ledger[comp], turns: s.ledger[comp].turns + 1 };
  return s;
}

function applyMove(s: InterviewState, move: ProposedMove, question: string): void {
  switch (move.action) {
    case "follow_up":
      s.thread.followUps++;
      break;
    case "clarify":
      s.thread.clarifies++;
      break;
    case "challenge":
      s.thread.challenges++;
      break;
    case "probe_resume": {
      const claim = s.claims.find((c) => c.id === move.target);
      if (claim) claim.probes++;
      const comp = claim?.competency && s.ledger[claim.competency] ? claim.competency : null;
      if (comp && comp !== s.thread.competency) startThread(s, comp, question);
      break;
    }
    case "adjust_difficulty": {
      const comp = move.competency ?? s.thread.competency;
      const l = comp ? s.ledger[comp] : undefined;
      if (comp && l) {
        const next = Math.max(1, Math.min(3, l.difficulty + (move.direction === "down" ? -1 : 1))) as Difficulty;
        s.ledger[comp] = { ...l, difficulty: next, lastAdjustTurn: s.turn };
      }
      s.thread.followUps++;
      break;
    }
    case "switch_competency":
      startThread(s, move.competency ?? null, question);
      break;
    case "test_contradiction": {
      const c = s.contradictions.find((x) => x.id === move.target);
      if (c) c.status = "tested";
      break;
    }
    case "wrap":
      s.phase = "candidate-questions";
      s.handOverTurn = s.turn;
      startThread(s, null, question);
      break;
  }
}

// ——— merge the background model's analysis ———

export function mergeModelAnalysis(prev: InterviewState, results: ModelAnswerAnalysis[], history: HistoryEntry[], now: number): InterviewState {
  const s = structuredClone(prev);
  for (const r of results) {
    const entry = history[r.index];
    if (!entry || entry.speaker !== "candidate" || s.modelAnalyzed.includes(r.index)) continue;
    const answer = entry.text;
    const heuristicWeights = new Map<string, number>();
    for (const [id, l] of Object.entries(s.ledger)) {
      const e = l.evidence.find((x) => x.turn === r.index);
      if (e) heuristicWeights.set(id, e.weight);
    }
    for (const c of r.competencies) {
      const ledger = s.ledger[c.id];
      // No verified quote, no score: an unsupported number never reaches the ledger.
      if (!ledger || !c.quote || !verifyQuote(c.quote, answer)) continue;
      s.ledger[c.id] = addEvidence(ledger, {
        turn: r.index,
        quote: c.quote.slice(0, 200),
        quality: c.quality,
        score: c.quality === "silent" ? null : Math.max(1, Math.min(5, Math.round(c.score))) * 2,
        weight: heuristicWeights.get(c.id) ?? 0.5,
        source: "model",
        ...((c.strength || c.weakness) ? { note: (c.score >= 3 ? c.strength ?? c.weakness : c.weakness ?? c.strength)!.slice(0, 140) } : {}),
      });
    }
    if (r.rubric) {
      const ts = s.threads.find((t) => t.answers.includes(r.index));
      if (ts) {
        const evidence: RubricEntry["evidence"] = {};
        for (const [k, v] of Object.entries(r.rubric.evidence) as [keyof RubricScores, string | undefined][]) {
          if (v && verifyQuote(v, answer)) evidence[k] = v.slice(0, 300);
        }
        const prior = ts.source === "model" && ts.entry ? ts.entry.scores : null;
        const scores: RubricScores = prior
          ? {
              relevance: clamp5((prior.relevance + r.rubric.scores.relevance) / 2),
              structure: clamp5((prior.structure + r.rubric.scores.structure) / 2),
              depth: clamp5((prior.depth + r.rubric.scores.depth) / 2),
              communication: clamp5((prior.communication + r.rubric.scores.communication) / 2),
            }
          : r.rubric.scores;
        const transcript = ts.answers.map((i) => history[i]?.text ?? "").filter((t) => t && !isNoAnswer(t)).join(" ");
        ts.entry = {
          questionId: ts.id,
          question: (ts.question || extractQuestion([...history.slice(0, r.index)].reverse().find((h) => h.speaker === "interviewer")?.text ?? "")).slice(0, 1200) || "Interview question",
          answerTranscript: transcript.slice(0, 8000),
          scores,
          evidence: { ...(ts.entry?.evidence ?? {}), ...evidence },
          tips: { ...(ts.entry?.tips ?? {}), ...r.rubric.tips },
        };
        ts.source = "model";
      }
    }
    const fresh: Claim[] = [];
    for (const mc of r.claims) {
      if (!mc.quote || !verifyQuote(mc.quote, answer)) continue;
      const { area, tech } = canonicalArea(`${mc.area} ${mc.text}`);
      const claim: Claim = {
        id: `c${s.seq++}`,
        text: mc.text.slice(0, 140),
        area: area ?? (tech ?? mc.area.toLowerCase().slice(0, 40)),
        ...(tech ? { tech } : {}),
        kind: mc.kind,
        polarity: mc.polarity,
        source: "model",
        turn: r.index,
        quote: mc.quote.slice(0, 200),
        status: "unverified",
        confidence: 0.6,
        evidence: [],
        probes: 0,
        ...(s.thread.competency ? { competency: s.thread.competency } : {}),
      };
      const dup = s.claims.some((c) => c.kind === claim.kind && c.area === claim.area && c.tech === claim.tech && c.polarity === claim.polarity);
      if (!dup) fresh.push(claim);
    }
    if (fresh.length) {
      const opened = detectContradictions(fresh, s.claims, s.contradictions, () => `c${s.seq++}`).map((c) => ({ ...c, source: "model" as const }));
      s.claims = [...s.claims, ...fresh].slice(-MAX_CLAIMS);
      s.contradictions = [...s.contradictions, ...opened].slice(-8);
    }
    for (const mc of r.contradictions) {
      const earlier = s.claims.find((c) => c.id === mc.claimId);
      if (!earlier || !mc.quote || !verifyQuote(mc.quote, answer) || verifyQuote(mc.quote, earlier.quote)) continue;
      if (s.contradictions.some((x) => x.a === earlier.id && x.turnB === r.index)) continue;
      const laterId = `c${s.seq++}`;
      const later: Claim = {
        id: laterId,
        text: mc.quote.slice(0, 140),
        area: earlier.area,
        ...(earlier.tech ? { tech: earlier.tech } : {}),
        kind: "negation",
        polarity: earlier.polarity === 1 ? -1 : 1,
        source: "model",
        turn: r.index,
        quote: mc.quote.slice(0, 200),
        status: "contradicted",
        confidence: 0.6,
        evidence: [],
        probes: 0,
      };
      s.claims = [...s.claims, later].slice(-MAX_CLAIMS);
      earlier.status = "contradicted";
      const contradiction: Contradiction = {
          id: `c${s.seq++}`,
          kind: earlier.source === "resume" ? "resume" : "polarity",
          a: earlier.id,
          b: laterId,
          textA: earlier.text,
          textB: mc.quote.slice(0, 140),
          quoteA: earlier.quote,
          quoteB: mc.quote.slice(0, 200),
          turnA: earlier.turn,
          turnB: r.index,
          status: "open",
          explanation: mc.explanation.slice(0, 200),
          source: "model",
        };
      s.contradictions = [...s.contradictions, contradiction].slice(-8);
    }
    if (r.incorrect) {
      const comp = s.threads.find((t) => t.answers.includes(r.index))?.competency;
      if (comp && s.ledger[comp] && !s.ledger[comp].weakness) s.ledger[comp] = { ...s.ledger[comp], weakness: `Factual slip: ${r.incorrect.slice(0, 120)}` };
    }
    s.modelAnalyzed = capFront([...s.modelAnalyzed, r.index], MAX_ASKED);
  }
  s.updatedAt = now;
  return s;
}

// ——— the room's view ———

export function viewOf(s: InterviewState): InterviewView {
  const current = s.thread.competency;
  const difficulty = current && s.ledger[current] ? s.ledger[current].difficulty : s.plan.startingDifficulty;
  return {
    phase: s.phase,
    roleLabel: s.plan.roleLabel,
    roundType: s.plan.roundType,
    current,
    difficulty: DIFFICULTY_LABEL[difficulty],
    progress: requiredProgress(s),
    competencies: s.plan.competencies
      .filter((c) => c.id !== "logistics")
      .map((c) => ({
        id: c.id,
        label: c.label,
        required: c.required,
        coverage: Math.round(Math.min(1, (s.ledger[c.id]?.coverage ?? 0)) * 100) / 100,
        status: statusOf(s.ledger[c.id]),
      })),
    claims: {
      total: s.claims.length,
      supported: s.claims.filter((c) => c.status === "supported").length,
      contradicted: s.claims.filter((c) => c.status === "contradicted").length,
    },
    openContradictions: s.contradictions.filter((c) => c.status === "open").length,
    scoring: s.modelAnalyzed.length > 0 ? "model" : "heuristic",
  };
}

/** Competency score summary used by the brief and the closing turn. */
export function strongestAndWeakest(s: InterviewState): { strongest: string | null; weakest: string | null } {
  const scored = s.plan.competencies
    .filter((c) => c.id !== "logistics")
    .map((c) => ({ id: c.id, ...scoreOf(s.ledger[c.id]) }))
    .filter((x) => x.score !== null && x.confidence >= 0.3) as { id: string; score: number; confidence: number }[];
  if (!scored.length) return { strongest: null, weakest: null };
  scored.sort((a, b) => b.score - a.score);
  const strongest = scored[0].id;
  const weakest = scored.length > 1 ? scored[scored.length - 1].id : null;
  return { strongest, weakest: weakest === strongest ? null : weakest };
}
