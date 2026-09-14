import { describe, expect, it } from "vitest";
import { allowedMoves, recommendMove, validateMove } from "@/lib/interview/actions";
import { analyzeAnswer } from "@/lib/interview/analysis";
import { detectContradictions, extractClaims } from "@/lib/interview/claims";
import { addEvidence, emptyLedger, isCovered, MIN_COVERAGE } from "@/lib/interview/coverage";
import { commit, decide, ingest, initState, moveContext } from "@/lib/interview/engine";
import { fallbackText } from "@/lib/interview/fallback";
import { createPlan } from "@/lib/interview/plan";
import { buildReadinessReport } from "@/lib/interview/report";
import type { InterviewState } from "@/lib/interview/types";
import type { HistoryEntry, ResumeProfile } from "@/lib/types";

const NOW = 1_800_000_000_000;

function ids() {
  let n = 1;
  return () => `c${n++}`;
}

const PROFILE: ResumeProfile = {
  experienced: false,
  companies: [],
  skills: ["Java", "Spring Boot", "PostgreSQL", "REST APIs"],
  projects: [{ name: "Campus Cart", summary: "Spring Boot marketplace for students" }],
};

describe("interview plan", () => {
  it("builds a role-specific plan with required competencies and resume claims to verify", () => {
    const { plan, claims } = createPlan({ role: "java-sde-fresher", roundType: "technical", candidateName: "Asha", profile: PROFILE }, ids());
    const comp = plan.competencies.map((c) => c.id);
    expect(plan.family).toBe("java");
    expect(comp).toEqual(expect.arrayContaining(["java", "oop", "dsa", "problem-solving", "projects"]));
    expect(plan.competencies.find((c) => c.id === "java")?.required).toBe(true);
    expect(plan.coding).toBe(true);
    expect(plan.claimsToVerify.length).toBeGreaterThan(0);
    expect(claims.some((c) => c.tech === "spring boot")).toBe(true);
  });

  it("gives a frontend role different competencies than a java role", () => {
    const java = createPlan({ role: "java-sde-fresher", roundType: "technical", candidateName: "A" }, ids()).plan;
    const fe = createPlan({ role: "frontend-fresher", roundType: "technical", candidateName: "A" }, ids()).plan;
    expect(fe.competencies.map((c) => c.id)).toContain("frontend-ui");
    expect(fe.competencies.map((c) => c.id)).not.toContain("java");
    expect(java.competencies.map((c) => c.id)).not.toContain("frontend-ui");
  });

  it("uses behavioural competencies for an HR round and lets a job description make ground required", () => {
    const hr = createPlan({ role: "general", roundType: "hr", candidateName: "A" }, ids()).plan;
    expect(hr.competencies.map((c) => c.id)).toEqual(expect.arrayContaining(["communication", "ownership", "teamwork"]));
    const withJd = createPlan(
      { role: "general", roundType: "technical", candidateName: "A", jobDescription: "We need strong system design: scalability, cache, load balancer and queue experience." },
      ids(),
    ).plan;
    expect(withJd.competencies.find((c) => c.id === "system-design")?.required).toBe(true);
  });
});

describe("coverage", () => {
  const strong =
    "I designed the order service in Spring Boot because the old monolith timed out; I added a Redis cache and cut p95 latency from 900ms to 120ms, and I load-tested it with 2000 users.";
  const vague = "I think it was good, we did many things and it worked well mostly.";

  it("a strong answer adds real coverage; a vague one does not", () => {
    const { plan } = createPlan({ role: "java-sde-fresher", roundType: "technical", candidateName: "A" }, ids());
    const a = analyzeAnswer(strong, { index: 1, question: "Tell me about a project", threadCompetency: "projects", plan });
    const v = analyzeAnswer(vague, { index: 3, question: "Tell me about a project", threadCompetency: "projects", plan });
    expect(a.quality).toBe("strong");
    expect(v.quality).toBe("vague");
  });

  it("vague answers never complete a competency, however many there are", () => {
    let l = emptyLedger("projects", 2);
    for (let i = 0; i < 10; i++) l = addEvidence(l, { turn: i, quote: "", quality: "vague", score: 3.5, weight: 1, source: "heuristic" });
    expect(l.coverage).toBeLessThan(MIN_COVERAGE);
    expect(isCovered(l)).toBe(false);
  });

  it("two strong answers cover a competency, and a model reading supersedes the heuristic one", () => {
    let l = emptyLedger("java", 2);
    l = addEvidence(l, { turn: 1, quote: "x", quality: "strong", score: 8, weight: 1, source: "heuristic" });
    l = addEvidence(l, { turn: 3, quote: "y", quality: "strong", score: 8, weight: 1, source: "heuristic" });
    expect(isCovered(l)).toBe(true);
    const before = l.evidence.length;
    l = addEvidence(l, { turn: 3, quote: "y", quality: "adequate", score: 6, weight: 1, source: "model" });
    expect(l.evidence.length).toBe(before);
    expect(l.evidence.find((e) => e.turn === 3)?.source).toBe("model");
  });
});

describe("contradictions", () => {
  it("detects owning the backend vs only working on the frontend, anchored to both quotes", () => {
    const next = ids();
    const early = extractClaims("In that project I designed the backend architecture.", { turn: 3, nextId: next });
    const late = extractClaims("Honestly I only worked on the frontend.", { turn: 10, nextId: next });
    expect(early[0]).toMatchObject({ area: "backend", kind: "ownership" });
    expect(late[0]).toMatchObject({ area: "frontend", exclusive: true });
    const found = detectContradictions(late, early, [], next);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "scope", turnA: 3, turnB: 10, status: "open" });
    expect(found[0].quoteA).toContain("I designed the backend architecture");
    expect(found[0].quoteB).toContain("I only worked on the frontend");
  });

  it("does not flag consistent claims or a qualification inside one answer", () => {
    const next = ids();
    const a = extractClaims("I built the REST API in Spring Boot.", { turn: 2, nextId: next });
    const b = extractClaims("I also deployed the API to AWS.", { turn: 4, nextId: next });
    expect(detectContradictions(b, a, [], next)).toHaveLength(0);
    const same = extractClaims("I designed the backend architecture, though I mostly worked on the frontend.", { turn: 5, nextId: next });
    expect(detectContradictions(same, same, [], next)).toHaveLength(0);
  });

  it("detects a polarity contradiction and a resume contradiction", () => {
    const next = ids();
    const used = extractClaims("I built the service using Docker.", { turn: 2, nextId: next });
    const never = extractClaims("I have never used Docker.", { turn: 6, nextId: next });
    expect(detectContradictions(never, used, [], next)[0]?.kind).toBe("polarity");
    const { claims } = createPlan({ role: "java-sde-fresher", roundType: "technical", candidateName: "A", profile: PROFILE }, next);
    const denies = extractClaims("I haven't worked with PostgreSQL.", { turn: 4, nextId: next });
    expect(detectContradictions(denies, claims, [], next)[0]?.kind).toBe("resume");
  });
});

// ——— driving whole interviews through the engine with the deterministic interviewer ———

function start(profile?: ResumeProfile, roundType: "hr" | "technical" = "technical"): InterviewState {
  return initState({ sid: "test-session", now: NOW, role: "java-sde-fresher", roundType, candidateName: "Asha Rao", profile });
}

/** Run a whole round where `answer` plays the candidate. Returns the final
 * state, history and every decision kind taken. */
function simulate(answer: (turn: number, question: string) => string, opts: { profile?: ResumeProfile; roundType?: "hr" | "technical"; maxTurns?: number } = {}) {
  let state = start(opts.profile, opts.roundType ?? "technical");
  const history: HistoryEntry[] = [];
  const kinds: string[] = [];
  const moves: string[] = [];
  let now = NOW;
  for (let t = 0; t < (opts.maxTurns ?? 60); t++) {
    now += 45_000;
    const ingested = ingest(state, history, now);
    state = ingested.state;
    const last = ingested.analyses[ingested.analyses.length - 1] ?? null;
    const d = decide(state, history, last, now);
    kinds.push(d.kind);
    let move = d.recommended;
    if (d.kind === "move" && move) {
      const verdict = validateMove(move, moveContext(state, history, last, now));
      expect(verdict.ok).toBe(true);
      moves.push(move.action);
    }
    let text = d.kind === "coding" ? "Time for the hands-on question. The editor is open — write a function that reverses a linked list." : fallbackText({ state, decision: d, move, candidateName: "Asha Rao", profile: opts.profile, lastQuestion: history.filter((h) => h.speaker === "interviewer").pop()?.text ?? "" });
    const kind = d.kind === "move" && move?.action === "wrap" ? "hand-over" : d.kind;
    if (kind === "hand-over" && d.kind === "move") move = null;
    expect(text.length).toBeGreaterThan(0);
    state = commit(state, { kind, move: kind === "move" ? move : null, text, source: "fallback" }, now);
    history.push({ speaker: "interviewer", text });
    if (state.phase === "done") break;
    const reply = d.kind === "coding" ? "```\nNode reverse(Node h){ Node p=null; while(h!=null){ Node n=h.next; h.next=p; p=h; h=n; } return p; } // O(n) time, O(1) space\n```" : answer(t, text);
    history.push({ speaker: "candidate", text: reply });
    text = "";
  }
  return { state, history, kinds, moves, now };
}

describe("adaptive turn engine", () => {
  it("validates moves: rejects unsupported actions, unknown targets and wrap while required ground is missing", () => {
    const s = commit(start(PROFILE), { kind: "open", text: "Hi Asha, tell me about a project you built.", source: "fallback" }, NOW);
    const history: HistoryEntry[] = [
      { speaker: "interviewer", text: "Hi Asha, tell me about a project you built." },
      { speaker: "candidate", text: "I built a marketplace." },
    ];
    const { state, analyses } = ingest(s, history, NOW + 1000);
    const ctx = moveContext(state, history, analyses[0], NOW + 1000);
    expect(validateMove({ action: "dance" }, ctx)).toEqual({ ok: false, reason: "unsupported or malformed action" });
    expect(validateMove({ action: "probe_resume", target: "nope" }, ctx).ok).toBe(false);
    expect(validateMove({ action: "test_contradiction", target: "nope" }, ctx).ok).toBe(false);
    const wrap = validateMove({ action: "wrap" }, ctx);
    expect(wrap.ok).toBe(false);
    expect(!wrap.ok && wrap.reason).toMatch(/required competencies/);
    expect(validateMove({ action: "switch_competency", competency: "dsa" }, ctx).ok).toBe(false); // projects not yet assessed
    expect(validateMove({ action: "challenge", evidence: "words they never said" }, ctx).ok).toBe(false);
    expect(allowedMoves(ctx).every((m) => validateMove(m, ctx).ok)).toBe(true);
  });

  it("refuses to follow up forever and to repeat the same move", () => {
    let s = commit(start(), { kind: "open", text: "Tell me about your project.", source: "fallback" }, NOW);
    const history: HistoryEntry[] = [{ speaker: "interviewer", text: "Tell me about your project." }];
    let last = null;
    for (let i = 0; i < 2; i++) {
      history.push({ speaker: "candidate", text: "It was a web app for students where they could buy and sell books." });
      const r = ingest(s, history, NOW + i);
      s = r.state;
      last = r.analyses[0];
      s = commit(s, { kind: "move", move: { action: "follow_up", competency: "projects" }, text: `Follow up number ${i}?`, source: "fallback" }, NOW + i);
      history.push({ speaker: "interviewer", text: `Follow up number ${i}?` });
    }
    history.push({ speaker: "candidate", text: "We used React and a Node backend with MongoDB." });
    const r = ingest(s, history, NOW + 10);
    const ctx = moveContext(r.state, history, r.analyses[0] ?? last, NOW + 10);
    const again = validateMove({ action: "follow_up", competency: "projects" }, ctx);
    expect(again.ok).toBe(false);
  });

  it("a strong candidate and a weak candidate get different consequences", () => {
    const strongAnswer =
      "I built the checkout service in Spring Boot because the monolith kept timing out; I split it into two services, added a Redis cache and cut p95 latency from 900ms to 120ms, which I verified with a load test of 2000 users.";
    const weak = simulate(() => "I don't know.");
    const strong = simulate(() => strongAnswer);
    expect(strong.state.phase).toBe("done");
    expect(weak.state.phase).toBe("done");
    expect(weak.moves).not.toEqual(strong.moves);
    expect(weak.moves[0]).toBe("clarify");
    expect(strong.moves[0]).not.toBe("clarify");
    expect(weak.state.struggles.length).toBeGreaterThan(0);
    expect(strong.state.struggles).toHaveLength(0);
    // Above the easiest level, a tap-out steps the difficulty down instead of re-asking.
    let s = commit(start(), { kind: "open", text: "Tell me about a project you built?", source: "fallback" }, NOW);
    s = { ...s, ledger: { ...s.ledger, projects: { ...s.ledger.projects, difficulty: 2 } } };
    const h: HistoryEntry[] = [
      { speaker: "interviewer", text: "Tell me about a project you built?" },
      { speaker: "candidate", text: "I don't know." },
    ];
    const r = ingest(s, h, NOW + 1000);
    expect(decide(r.state, h, r.analyses[0], NOW + 1000).recommended).toMatchObject({ action: "adjust_difficulty", direction: "down" });
    const report = (sim: typeof strong) => buildReadinessReport(sim.state, sim.history, sim.now);
    expect(report(weak).verdict).not.toBe("READY");
    expect((report(strong).overall ?? 0) > (report(weak).overall ?? 0)).toBe(true);
  });

  it("raises a detected contradiction with both of the candidate's statements", () => {
    const script = [
      "In our final-year project I designed the backend architecture and set up the REST endpoints for orders and payments.",
      "Honestly I only worked on the frontend, the React pages, someone else did everything on the server.",
    ];
    const sim = simulate((t) => script[Math.min(t, script.length - 1)] ?? script[1], { maxTurns: 4 });
    const asked = sim.history.filter((h) => h.speaker === "interviewer").map((h) => h.text);
    expect(sim.state.contradictions.length).toBeGreaterThan(0);
    expect(asked.some((q) => /Earlier you mentioned that you designed the backend architecture/.test(q) && /only worked on the frontend/.test(q))).toBe(true);
  });

  it("a silent candidate is re-asked, never skipped, and the round still completes", () => {
    const sim = simulate(() => "(no answer)");
    expect(sim.state.phase).toBe("done");
    expect(sim.moves[0]).toBe("clarify");
    expect(sim.state.struggles.length).toBeGreaterThan(0);
  });

  it("a fallback-driven interview completes with coding, a hand-over and a close, never repeating a question", () => {
    const answers = [
      "I built Campus Cart, a Spring Boot marketplace; I designed the REST API and the PostgreSQL schema because listings needed search, and it served about 300 students.",
      "I used JPA with indexes on the title column, which cut search time from 2 seconds to 200ms when I measured it.",
      "A HashMap stores entries in buckets by hash; on collision Java chains them and turns long chains into trees, so lookups stay close to O(1).",
      "Polymorphism lets me call the same method on different subclasses, for example a PaymentProcessor interface with UPI and card implementations I wrote.",
      "For top ten of a million records I would use a min-heap of size ten, which is O(n log k) instead of sorting everything.",
    ];
    const sim = simulate((t) => answers[t % answers.length], { profile: PROFILE });
    expect(sim.state.phase).toBe("done");
    expect(sim.kinds).toContain("coding");
    expect(sim.kinds.some((k) => k === "hand-over" || k === "answer-questions")).toBe(true);
    expect(sim.kinds[sim.kinds.length - 1]).toBe("close");
    const questions = sim.history.filter((h) => h.speaker === "interviewer").map((h) => h.text);
    expect(new Set(questions).size).toBe(questions.length);
    const report = buildReadinessReport(sim.state, sim.history, sim.now);
    expect(["READY", "ALMOST READY", "NEEDS PRACTICE", "NOT READY"]).toContain(report.verdict);
    expect(report.competencies.length).toBeGreaterThan(3);
    expect(report.practicePlan.length).toBeGreaterThan(0);
  });

  it("recommendMove always returns a move that passes validation", () => {
    const sim = simulate((t) => (t % 3 === 0 ? "I don't know." : "I built a REST API in Spring Boot with PostgreSQL because we needed transactions."), { maxTurns: 8 });
    const ctx = moveContext(sim.state, sim.history, null, sim.now);
    if (sim.state.phase !== "done") expect(validateMove(recommendMove(ctx), ctx).ok).toBe(true);
  });
});
