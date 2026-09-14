import { isAssessed, isCovered, isSufficient, unassessedRequired } from "@/lib/interview/coverage";
import {
  ACTIONS,
  type ActionType,
  type AnswerAnalysis,
  type AnswerQuality,
  type InterviewState,
  type MoveOption,
  type MoveVerdict,
  type ProposedMove,
} from "@/lib/interview/types";
import { verifyQuote } from "@/lib/rubric";

// The conversational moves an interviewer can make, and the rules that decide
// whether a proposed move is allowed RIGHT NOW.
//
// The model proposes; this module disposes. Every rule below is a real
// interviewing failure the app refuses to make regardless of what the model
// wants: probing ground that is already covered, following up forever,
// challenging without evidence, jumping away before a competency is assessed,
// wrapping up with required ground uncovered. Answer counts survive only as
// hard safety caps (hardCapReason) — they never decide the next move.

export const MAX_FOLLOW_UPS = 2;
/** ONE request for specifics per thread. A second "be concrete" is the sound of
 * an interviewer not listening; a still-thin answer is information, not a
 * prompt to loop — record the struggle and move on. */
export const MAX_CLARIFIES = 1;
export const MAX_CHALLENGES = 1;
/** Interviewer turns one competency thread may run before switching is allowed
 * regardless of coverage — an honest "I don't know" must not trap anyone. */
export const MAX_THREAD_TURNS = 4;
export const MAX_CLAIM_PROBES = 2;
export const ADJUST_COOLDOWN_TURNS = 2;
export const HARD_TURN_CAP = 40;
export const TIME_CAP_FACTOR = 1.5;

export interface MoveContext {
  state: InterviewState;
  last: AnswerAnalysis | null;
  /** Recent candidate answers, newest last — what a move's evidence must quote. */
  recentAnswers: string[];
  now: number;
}

const fail = (reason: string): MoveVerdict => ({ ok: false, reason });
const ok = (move: ProposedMove): MoveVerdict => ({ ok: true, move });

function planHas(state: InterviewState, id: string | undefined): id is string {
  return Boolean(id && state.plan.competencies.some((c) => c.id === id));
}

function threadTurns(state: InterviewState): number {
  return state.turn - state.thread.startTurn;
}

function lastMoves(state: InterviewState, n: number) {
  return state.actions.filter((a) => a.kind === "move").slice(-n);
}

/** Qualities of the most recent answers credited to a competency. */
function recentQualities(state: InterviewState, competency: string, n: number): AnswerQuality[] {
  const ledger = state.ledger[competency];
  if (!ledger) return [];
  return [...ledger.evidence]
    .filter((e) => e.weight >= 1)
    .sort((a, b) => a.turn - b.turn)
    .slice(-n)
    .map((e) => e.quality);
}

export function hardCapReason(ctx: MoveContext): string | null {
  const { state, now } = ctx;
  if (state.answers >= state.plan.maxAnswers) return `answer cap (${state.plan.maxAnswers}) reached`;
  if (state.turn >= HARD_TURN_CAP) return "interviewer turn cap reached";
  const minutes = (now - state.createdAt) / 60_000;
  if (minutes >= state.plan.targetMinutes * TIME_CAP_FACTOR) return `time cap reached (${Math.round(minutes)} min)`;
  return null;
}

export function wrapCheck(ctx: MoveContext): { ok: boolean; reason?: string } {
  if (hardCapReason(ctx)) return { ok: true };
  const missing = unassessedRequired(ctx.state);
  if (missing.length) return { ok: false, reason: `required competencies not yet assessed: ${missing.join(", ")}` };
  if (ctx.state.contradictions.some((c) => c.status === "open")) {
    return { ok: false, reason: "an open contradiction has not been raised with the candidate yet" };
  }
  return { ok: true };
}

/** Coerce whatever the model sent into a move, or null when it is not one. */
export function normalizeMove(raw: unknown): ProposedMove | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const action = typeof r.action === "string" ? r.action.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (!(ACTIONS as readonly string[]).includes(action)) return null;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const direction = r.direction === "up" || r.direction === "down" ? r.direction : undefined;
  return {
    action: action as ActionType,
    ...(str(r.competency, 40) ? { competency: str(r.competency, 40) } : {}),
    ...(str(r.target, 40) ? { target: str(r.target, 40) } : {}),
    ...(direction ? { direction } : {}),
    ...(str(r.evidence, 240) ? { evidence: str(r.evidence, 240) } : {}),
  };
}

export function validateMove(raw: unknown, ctx: MoveContext): MoveVerdict {
  const move = normalizeMove(raw);
  if (!move) return fail("unsupported or malformed action");
  const { state, last } = ctx;
  const current = state.thread.competency;

  // The same move three times running is a loop, whatever the rules below say.
  const prev = lastMoves(state, 2);
  if (
    prev.length === 2 &&
    prev.every((p) => p.action === move.action && (p.target ?? "") === (move.target ?? "") && (p.competency ?? current ?? "") === (move.competency ?? current ?? ""))
  ) {
    return fail(`repeated ${move.action} three times in a row`);
  }

  switch (move.action) {
    case "follow_up": {
      const comp = move.competency ?? current ?? undefined;
      if (!planHas(state, comp)) return fail("follow_up needs the competency currently being assessed");
      if (current && comp !== current) return fail("follow_up stays on the current competency — use switch_competency to change");
      if (!last) return fail("there is no answer to follow up on yet");
      if (last.quality === "silent") return fail("the candidate said nothing — clarify instead");
      if (state.thread.followUps >= MAX_FOLLOW_UPS) return fail(`already followed up ${MAX_FOLLOW_UPS} times in this thread`);
      if (isSufficient(state.ledger[comp])) return fail(`${comp} is already sufficiently covered`);
      if (threadTurns(state) >= MAX_THREAD_TURNS) return fail("this thread has run its course — switch or wrap");
      return ok({ ...move, competency: comp });
    }
    case "clarify": {
      const comp = move.competency ?? current ?? undefined;
      if (!last) return fail("there is nothing to clarify yet");
      if (last.quality === "strong") return fail("the last answer was clear and specific — nothing to clarify");
      if (state.thread.clarifies >= MAX_CLARIFIES) return fail(`already asked for clarification ${MAX_CLARIFIES} times in this thread`);
      if (prev[prev.length - 1]?.action === "clarify") return fail("clarified on the previous turn — take the answer or change approach");
      return ok({ ...move, ...(planHas(state, comp) ? { competency: comp } : {}) });
    }
    case "challenge": {
      if (!last) return fail("there is nothing to challenge yet");
      if (last.quality === "silent" || last.quality === "tap-out") return fail("never challenge silence or an honest 'I don't know'");
      if (state.thread.challenges >= MAX_CHALLENGES) return fail("already challenged once in this thread");
      const quoted = Boolean(move.evidence && ctx.recentAnswers.some((a) => verifyQuote(move.evidence!, a)));
      const flagged =
        last.flags.includes("overclaim") ||
        last.flags.includes("hedged") ||
        last.flags.includes("off-topic") ||
        last.quality === "vague" ||
        state.claims.some((c) => c.turn === last.index && c.source !== "resume" && c.status === "unverified");
      if (!quoted && !flagged) return fail("challenge needs evidence — quote the candidate's own words");
      if (move.evidence && !quoted) return fail("the quoted evidence is not in the candidate's answers");
      return ok({ ...move, ...(current ? { competency: move.competency ?? current } : {}) });
    }
    case "probe_resume": {
      const claim = state.claims.find((c) => c.id === move.target);
      if (!claim) return fail("probe_resume needs the id of a known claim");
      if (claim.status === "supported") return fail("that claim is already supported by evidence");
      if (claim.status === "contradicted") return fail("that claim is contradicted — use test_contradiction");
      if (claim.probes >= MAX_CLAIM_PROBES) return fail("that claim has already been probed enough");
      const comp = claim.competency && planHas(state, claim.competency) ? claim.competency : (current ?? undefined);
      // Claims the model lifts from answers are plentiful; verifying one more on
      // ground that is already assessed is how a round got stuck on one
      // competency for eleven turns. Resume claims stay probeable.
      if (comp === current && threadTurns(state) >= MAX_THREAD_TURNS) return fail("this thread has run its course — switch or wrap");
      if (claim.source !== "resume" && comp && isAssessed(state.ledger[comp]) && comp === current) {
        return fail(`${comp} is already assessed — move on rather than verifying more of it`);
      }
      return ok({ ...move, ...(comp ? { competency: comp } : {}) });
    }
    case "adjust_difficulty": {
      const comp = move.competency ?? current ?? undefined;
      if (!planHas(state, comp)) return fail("adjust_difficulty needs the current competency");
      const ledger = state.ledger[comp];
      const direction = move.direction;
      if (!direction) return fail("adjust_difficulty needs a direction");
      if (!last) return fail("no answer to base a difficulty change on");
      if (state.turn - ledger.lastAdjustTurn < ADJUST_COOLDOWN_TURNS) return fail("difficulty was just adjusted");
      if (direction === "up") {
        if (ledger.difficulty >= 3) return fail("already at the hardest level");
        if (last.quality !== "strong") return fail("raise difficulty only after a strong answer");
      } else {
        if (ledger.difficulty <= 1) return fail("already at the easiest level");
        if (!["tap-out", "vague", "silent"].includes(last.quality)) return fail("lower difficulty only after the candidate struggled");
      }
      return ok({ ...move, competency: comp });
    }
    case "switch_competency": {
      const target = move.competency;
      if (!planHas(state, target)) return fail("switch_competency needs a competency from the plan");
      if (target === current) return fail("already assessing that competency");
      if (current && planHas(state, current)) {
        const ledger = state.ledger[current];
        const exhausted = threadTurns(state) >= MAX_THREAD_TURNS || (ledger?.struggles ?? 0) >= 2;
        const tappedOutTwice = recentQualities(state, current, 2).filter((q) => q === "tap-out" || q === "silent").length >= 2;
        // Probed once and still thin: take the answer and move on rather than
        // asking again in other words.
        const probedOnce = (state.thread.clarifies >= 1 || state.thread.challenges >= 1) && last !== null && ["vague", "tap-out", "silent"].includes(last.quality);
        const spentTwo = state.thread.followUps + state.thread.clarifies + state.thread.challenges >= 2 && (ledger?.evidence.length ?? 0) >= 1;
        if (!isAssessed(ledger) && !exhausted && !tappedOutTwice && !probedOnce && !spentTwo) {
          return fail(`${current} has not reached minimum coverage yet`);
        }
      }
      if (isSufficient(state.ledger[target]) && unassessedRequired(state).some((id) => id !== target)) {
        return fail(`${target} is already covered while required competencies remain`);
      }
      return ok(move);
    }
    case "test_contradiction": {
      const c = state.contradictions.find((x) => x.id === move.target);
      if (!c) return fail("test_contradiction needs the id of a detected contradiction");
      if (c.status !== "open") return fail("that contradiction has already been raised");
      return ok(move);
    }
    case "wrap": {
      const w = wrapCheck(ctx);
      return w.ok ? ok(move) : fail(w.reason ?? "wrap is not allowed yet");
    }
  }
}

/** The next competency worth moving to: required and unassessed first, weighted
 * by how little is known; then optional ground if there is budget for it. */
export function nextCompetency(ctx: MoveContext): string | null {
  const { state } = ctx;
  const current = state.thread.competency;
  const candidates = state.plan.competencies.filter((c) => c.id !== current);
  const unassessed = (required: boolean) =>
    candidates
      .filter((c) => c.required === required && !isAssessed(state.ledger[c.id]))
      .sort((a, b) => b.weight * (1 - (state.ledger[b.id]?.coverage ?? 0)) - a.weight * (1 - (state.ledger[a.id]?.coverage ?? 0)));
  const required = unassessed(true);
  if (required.length) return required[0].id;
  const budgetLeft = state.answers < state.plan.maxAnswers - 3 && (ctx.now - state.createdAt) / 60_000 < state.plan.targetMinutes;
  if (budgetLeft) {
    const optional = unassessed(false).filter((c) => c.weight >= 0.5);
    if (optional.length) return optional[0].id;
  }
  return null;
}

/** A different valid move when the model's own choice produced a repeat: new
 * ground first, then a claim to verify, then anything else that validates. */
export function alternativeMove(ctx: MoveContext, exclude: readonly ActionType[]): ProposedMove | null {
  const order: ActionType[] = ["switch_competency", "probe_resume", "test_contradiction", "adjust_difficulty", "challenge", "follow_up", "clarify"];
  const options = allowedMoves(ctx).filter((m) => !exclude.includes(m.action));
  for (const action of order) {
    const found = options.find((m) => m.action === action);
    if (found) return { action: found.action, ...(found.competency ? { competency: found.competency } : {}), ...(found.target ? { target: found.target } : {}), ...(found.direction ? { direction: found.direction } : {}) };
  }
  return null;
}

/** Every move that would pass validation right now, with the reason it fits. */
export function allowedMoves(ctx: MoveContext): MoveOption[] {
  const { state, last } = ctx;
  const current = state.thread.competency ?? undefined;
  const candidates: MoveOption[] = [];
  const add = (m: ProposedMove, reason: string) => {
    const v = validateMove(m, ctx);
    if (v.ok) candidates.push({ ...v.move, reason });
  };

  for (const c of state.contradictions.filter((x) => x.status === "open").slice(0, 2)) {
    add({ action: "test_contradiction", target: c.id }, `earlier "${c.quoteA}" vs later "${c.quoteB}"`);
  }
  if (current) {
    add({ action: "follow_up", competency: current }, "dig into what they just said");
    add({ action: "clarify", competency: current }, last?.quality === "silent" ? "they said nothing — re-ask more simply" : "the answer was unclear or thin");
    if (last?.flags.includes("overclaim") || last?.quality === "vague") {
      add({ action: "challenge", competency: current }, last.flags.includes("overclaim") ? "a broad claim with little to back it" : "generic answer — press for something concrete");
    }
    if (last?.quality === "strong") add({ action: "adjust_difficulty", competency: current, direction: "up" }, "strong answer — raise the bar");
    if (last && ["tap-out", "vague", "silent"].includes(last.quality)) {
      add({ action: "adjust_difficulty", competency: current, direction: "down" }, "they struggled — step down a level");
    }
  }
  const claims = state.claims
    .filter((c) => c.status !== "supported" && c.status !== "contradicted" && c.probes < MAX_CLAIM_PROBES)
    .sort((a, b) => Number(a.source !== "resume") - Number(b.source !== "resume") || Number(b.competency === current) - Number(a.competency === current))
    .slice(0, 2);
  for (const c of claims) add({ action: "probe_resume", target: c.id }, `verify: ${c.text}`);
  const next = nextCompetency(ctx);
  if (next) add({ action: "switch_competency", competency: next }, isCovered(state.ledger[next]) ? "optional ground with time left" : "required ground not yet assessed");
  for (const c of state.plan.competencies) {
    if (c.id === next || c.id === current || !c.required || isAssessed(state.ledger[c.id])) continue;
    add({ action: "switch_competency", competency: c.id }, "required ground not yet assessed");
    if (candidates.filter((m) => m.action === "switch_competency").length >= 2) break;
  }
  add({ action: "wrap" }, "required ground is assessed");
  return candidates;
}

/** The deterministic interviewer's choice — the prompt's anchor and the move
 * the fallback executes when no model is available. Always a valid move. */
export function recommendMove(ctx: MoveContext): ProposedMove {
  const { state, last } = ctx;
  const current = state.thread.competency ?? undefined;
  const tryMove = (m: ProposedMove): ProposedMove | null => {
    const v = validateMove(m, ctx);
    return v.ok ? v.move : null;
  };
  const pick = (...moves: (ProposedMove | null | undefined)[]): ProposedMove | null => {
    for (const m of moves) {
      if (!m) continue;
      const valid = tryMove(m);
      if (valid) return valid;
    }
    return null;
  };

  if (hardCapReason(ctx)) return { action: "wrap" };
  const next = nextCompetency(ctx);
  const switchNext = next ? ({ action: "switch_competency", competency: next } as ProposedMove) : null;
  const open = state.contradictions.find((c) => c.status === "open");
  // Only the resume's own claims earn a probe by recommendation; answer-claims
  // are the model's to pick, and only while the ground is still open.
  const claimForCurrent = state.claims.find(
    (c) => c.status === "unverified" && c.probes === 0 && c.source === "resume" && c.competency === current,
  );
  const currentAssessed = Boolean(current && isAssessed(state.ledger[current]));

  const choice =
    pick(open ? { action: "test_contradiction", target: open.id } : null) ??
    (last?.quality === "silent" ? pick({ action: "clarify", competency: current }, switchNext) : null) ??
    (last?.quality === "tap-out"
      ? pick({ action: "adjust_difficulty", competency: current, direction: "down" }, switchNext, { action: "clarify", competency: current })
      : null) ??
    // Already asked for specifics once and it is still thin: move on.
    (last?.quality === "vague" && state.thread.clarifies >= 1 ? pick(switchNext, claimForCurrent ? { action: "probe_resume", target: claimForCurrent.id } : null, { action: "follow_up", competency: current }) : null) ??
    (last?.flags.includes("overclaim") ? pick({ action: "challenge", competency: current }) : null) ??
    (last?.quality === "vague" ? pick({ action: "clarify", competency: current }, { action: "follow_up", competency: current }) : null) ??
    (last?.quality === "strong" && current && !isSufficient(state.ledger[current])
      ? pick({ action: "adjust_difficulty", competency: current, direction: "up" }, { action: "follow_up", competency: current })
      : null) ??
    (current && !isCovered(state.ledger[current]) ? pick({ action: "follow_up", competency: current }) : null) ??
    // Assessed ground is left before anything else on it is verified.
    (currentAssessed ? pick(switchNext) : null) ??
    pick(claimForCurrent ? { action: "probe_resume", target: claimForCurrent.id } : null) ??
    pick(switchNext) ??
    pick({ action: "wrap" }) ??
    allowedMoves(ctx)[0] ??
    null;

  if (choice) return choice;
  // Nothing validates (a pathological state): keep talking about the current
  // ground rather than inventing an invalid move.
  return current ? { action: "follow_up", competency: current } : { action: "wrap" };
}
