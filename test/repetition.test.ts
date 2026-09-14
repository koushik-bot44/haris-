import { describe, expect, it } from "vitest";
import { analyzeAnswer } from "@/lib/interview/analysis";
import { findRepeats, alreadyAnswered } from "@/lib/interview/dedupe";
import { commit, decide, ingest, initState, moveContext } from "@/lib/interview/engine";
import { runAdaptiveTurn } from "@/lib/interview/orchestrator";
import { createPlan } from "@/lib/interview/plan";
import { validateMove } from "@/lib/interview/actions";
import { mockProvider } from "@/lib/llm/mock";
import type { AdaptiveLLMProvider, GenerateInput, GeneratedTurn } from "@/lib/llm/provider";
import type { HistoryEntry, ResumeProfile } from "@/lib/types";

// Regression suite for the failure a candidate reported: Haris asking the same
// question again — verbatim, reworded, or a follow-up whose answer was in the
// previous reply. Every scenario drives the real orchestrator, engine and
// memory checks; only the language model is scripted.

const NOW = 1_800_000_000_000;
const PROFILE: ResumeProfile = { experienced: false, companies: [], skills: ["Java", "Spring Boot", "MySQL", "REST APIs"], projects: [{ name: "Campus Cart", summary: "student marketplace" }] };
const REQ = { role: "java-sde-fresher" as const, roundType: "technical" as const, candidateName: "Asha", codeLanguage: "java" as const, profile: PROFILE };

/** Complete SPOKEN answers: no digits, few buzzwords, real content. */
const SPOKEN: Record<string, string[]> = {
  projects: [
    "So the main project I did was Campus Cart, it's basically a place where students in my college can buy and sell used books and cycles. I did the whole backend part, the login and the listing pages talk to my APIs, and my friend did the design side.",
    "I picked Spring Boot because we had learnt Java in college and I wanted something where the setup is quick, and honestly the auto configuration saved us a lot of time. The reason I did not go with Node was that nobody in the team knew JavaScript properly.",
    "The hardest part was when two students tried to buy the same item at the same time, both got success messages. I fixed it by adding a unique check in the database so only one order can exist per listing, and after that it never happened again.",
  ],
  java: [
    "A HashMap works by hashing the key and putting it into a bucket, and if two keys land in the same bucket it keeps them in a small list, and in newer Java versions it becomes a tree when the list gets long. So mostly lookups are constant time.",
    "Strings are immutable in Java so that they can be safely shared, like in the string pool, and also because the hash code can be cached, which is why they are good as map keys.",
  ],
  oop: [
    "Polymorphism is when the same method call behaves differently depending on the object. In Campus Cart I had a Payment interface and two classes, one for UPI and one for cash on delivery, and the order service just calls pay without caring which one it is.",
    "I would use an interface when I only want to promise the behaviour, and an abstract class when there is some common code I want to share, like a base class with the logging already written.",
  ],
  dsa: [
    "For top ten out of a million I would keep a small heap of size ten and go through the records once, so it's n log k instead of sorting everything, which would be n log n.",
    "To find if a linked list has a cycle I would use the slow and fast pointer, if fast catches up with slow there is a cycle, and it is linear time with constant space.",
  ],
  generic: ["I think the main thing is I try to understand the problem first, then I break it into smaller parts and test each part, that is what I did in my college projects as well."],
};
const CODE = "```\npublic static Character firstNonRepeating(String s){ Map<Character,Integer> c=new LinkedHashMap<>(); for(char ch: s.toCharArray()) c.merge(ch,1,Integer::sum); for(var e: c.entrySet()) if(e.getValue()==1) return e.getKey(); return null; } // O(n) time, O(k) space\n```";

function bankFor(question: string): string[] {
  const q = question.toLowerCase();
  if (/hashmap|hash map|string|jvm|garbage|collection|arraylist|linkedlist|java/.test(q)) return SPOKEN.java;
  if (/polymorph|interface|abstract|class|oop|solid|design pattern|parking/.test(q)) return SPOKEN.oop;
  if (/heap|linked list|complexity|array|algorithm|sort|search|top ten|million|lru|graph/.test(q)) return SPOKEN.dsa;
  if (/project|built|campus|spring|backend|api|bug|hardest|decision|why|choose|chose|resume/.test(q)) return SPOKEN.projects;
  return SPOKEN.generic;
}

interface Run {
  questions: string[];
  answers: string[];
  history: HistoryEntry[];
  scripted: number;
  done: boolean;
}

async function drive(provider: AdaptiveLLMProvider, maxTurns = 22): Promise<Run> {
  const history: HistoryEntry[] = [];
  const questions: string[] = [];
  const answers: string[] = [];
  const used = new Map<string[], number>();
  let state: string | undefined;
  let now = NOW;
  let scripted = 0;
  let done = false;
  for (let t = 0; t < maxTurns; t++) {
    now += 40_000;
    const res = await runAdaptiveTurn({ ...REQ, history, ...(state ? { state } : {}) }, { provider, now, memoryKey: null });
    state = res.state;
    questions.push(res.turn.text);
    if (res.turn.scripted) scripted++;
    history.push({ speaker: "interviewer", text: res.turn.text });
    if (res.turn.done) {
      done = true;
      break;
    }
    let answer: string;
    if (res.turn.coding) answer = CODE;
    else {
      const bank = bankFor(res.turn.text);
      const n = used.get(bank) ?? 0;
      used.set(bank, n + 1);
      answer = bank[n % bank.length];
    }
    answers.push(answer);
    history.push({ speaker: "candidate", text: answer });
  }
  return { questions, answers, history, scripted, done };
}

/** Which questions asked for something one of the earlier answers already covered. */
function askedTheAnswered(run: Run): [number, string][] {
  const out: [number, string][] = [];
  for (let i = 1; i < run.questions.length; i++) {
    const q = run.questions[i];
    if (!q.includes("?")) continue;
    const priorAnswers = run.answers.slice(0, i).filter((a) => !a.startsWith("```"));
    const covered = alreadyAnswered(q, priorAnswers);
    if (covered) out.push([i, q]);
  }
  return out;
}

function scriptedProvider(gen: (input: GenerateInput) => GeneratedTurn | null): AdaptiveLLMProvider {
  return {
    name: "scripted",
    adaptive: true,
    async nextTurn() {
      throw new Error("unused");
    },
    async generate(input) {
      return gen(input);
    },
  };
}

describe("the classifier reads complete spoken answers as complete", () => {
  it("does not call a full answer vague for lacking digits and buzzwords", () => {
    const { plan } = createPlan({ role: "java-sde-fresher", roundType: "technical", candidateName: "Asha", profile: PROFILE }, (() => { let n = 1; return () => `c${n++}`; })());
    const qualities = [...SPOKEN.projects, ...SPOKEN.java, ...SPOKEN.oop, ...SPOKEN.dsa].map((t) => analyzeAnswer(t, { index: 1, question: "?", threadCompetency: "projects", plan }).quality);
    expect(qualities.filter((q) => q === "vague" || q === "tap-out")).toEqual([]);
    const overclaim = analyzeAnswer(SPOKEN.projects[0], { index: 1, question: "?", threadCompetency: "projects", plan });
    expect(overclaim.flags).not.toContain("overclaim");
    // …while a genuinely empty answer still reads as vague.
    expect(analyzeAnswer("It was good, we did many things and it worked well mostly.", { index: 1, question: "?", threadCompetency: "projects", plan }).quality).toBe("vague");
  });
});

describe("repetition — deterministic interviewer (what speaks under a rate limit)", () => {
  it("never repeats a question, reworded or not, and never asks what was already answered", async () => {
    const run = await drive(mockProvider);
    const { exact, reworded } = findRepeats(run.questions);
    expect(exact).toEqual([]);
    expect(reworded).toEqual([]);
    expect(askedTheAnswered(run)).toEqual([]);
    expect(run.done).toBe(true);
  });

  it("does not stay on one competency for more than three consecutive questions after complete answers", async () => {
    const run = await drive(mockProvider);
    // Coding opens after the project thread; before it, complete answers must not
    // be met with a fourth question on the same ground.
    const codingAt = run.questions.findIndex((q) => /editor/i.test(q));
    expect(codingAt).toBeGreaterThanOrEqual(3);
    expect(codingAt).toBeLessThanOrEqual(5);
  });
});

describe("repetition — the model's words are checked before they are spoken", () => {
  it("rejects an exact repeat and a reworded repeat, and regenerates with a different move", async () => {
    const attempts: { forced: string | undefined; brief: string }[] = [];
    let n = 0;
    const provider = scriptedProvider((input) => {
      attempts.push({ forced: input.forcedMove?.action, brief: input.brief });
      if (input.kind === "open") return { text: "Hi Asha, I'm Haris. Tell me about a project you built — which parts were yours?", move: null, note: null, done: false };
      n++;
      if (n === 1) return { text: "Okay. Could you tell me about a project you built and which parts were yours?", move: { action: "follow_up", competency: "projects" }, note: null, done: false };
      return { text: "Got it. How does a HashMap handle two keys landing in the same bucket?", move: input.forcedMove, note: null, done: false };
    });
    const history: HistoryEntry[] = [];
    const t1 = await runAdaptiveTurn({ ...REQ, history }, { provider, now: NOW, memoryKey: null });
    history.push({ speaker: "interviewer", text: t1.turn.text }, { speaker: "candidate", text: SPOKEN.projects[0] });
    const t2 = await runAdaptiveTurn({ ...REQ, history, state: t1.state }, { provider, now: NOW + 40_000, memoryKey: null });
    expect(t2.turn.text).toContain("HashMap");
    expect(attempts).toHaveLength(3);
    expect(attempts[2].forced).toBeDefined();
    expect(attempts[2].forced).not.toBe("follow_up");
    expect(attempts[2].brief).toContain("PREVIOUS ATTEMPT WAS REJECTED");
  });

  it("rejects a follow-up whose answer is already in the transcript", async () => {
    let n = 0;
    const provider = scriptedProvider((input) => {
      if (input.kind === "open") return { text: "Hi Asha. Which project are you proudest of, and what was your part?", move: null, note: null, done: false };
      n++;
      if (n === 1) return { text: "Nice. Why did you choose Spring Boot for that project?", move: { action: "follow_up", competency: "projects" }, note: null, done: false };
      return { text: "Okay. What broke first when you tested Campus Cart with real users?", move: input.forcedMove ?? { action: "follow_up", competency: "projects" }, note: null, done: false };
    });
    const history: HistoryEntry[] = [];
    const t1 = await runAdaptiveTurn({ ...REQ, history }, { provider, now: NOW, memoryKey: null });
    history.push({ speaker: "interviewer", text: t1.turn.text }, { speaker: "candidate", text: SPOKEN.projects[1] });
    const t2 = await runAdaptiveTurn({ ...REQ, history, state: t1.state }, { provider, now: NOW + 40_000, memoryKey: null });
    expect(t2.turn.text).not.toMatch(/why did you choose spring boot/i);
    expect(t2.turn.text).toContain("broke first");
  });

  it("lets a genuinely deeper question on the same topic through", async () => {
    const provider = scriptedProvider((input) => {
      if (input.kind === "open") return { text: "Hi Asha. Tell me about Campus Cart — which parts did you build?", move: null, note: null, done: false };
      return { text: "Okay. What would break first in Campus Cart if ten times as many students used it tomorrow?", move: { action: "follow_up", competency: "projects" }, note: null, done: false };
    });
    const history: HistoryEntry[] = [];
    const t1 = await runAdaptiveTurn({ ...REQ, history }, { provider, now: NOW, memoryKey: null });
    history.push({ speaker: "interviewer", text: t1.turn.text }, { speaker: "candidate", text: SPOKEN.projects[0] });
    const t2 = await runAdaptiveTurn({ ...REQ, history, state: t1.state }, { provider, now: NOW + 40_000, memoryKey: null });
    expect(t2.turn.text).toContain("ten times");
    expect(t2.turn.scripted).toBeUndefined();
  });

  it("tells the model what was already asked and already established", async () => {
    let brief = "";
    const provider = scriptedProvider((input) => {
      brief = input.brief;
      if (input.kind === "open") return { text: "Hi Asha. Tell me about Campus Cart — which parts did you build?", move: null, note: null, done: false };
      return { text: `Okay. What would break first if ${brief.length} times as many students used it?`, move: { action: "follow_up", competency: "communication" }, note: null, done: false };
    });
    // An HR round: no coding turn interrupts the thread, so the third turn is a
    // model turn on ground with two answers behind it.
    const HR = { ...REQ, roundType: "hr" as const };
    const history: HistoryEntry[] = [];
    const t1 = await runAdaptiveTurn({ ...HR, history }, { provider, now: NOW, memoryKey: null });
    history.push({ speaker: "interviewer", text: t1.turn.text }, { speaker: "candidate", text: SPOKEN.projects[0] });
    const t2 = await runAdaptiveTurn({ ...HR, history, state: t1.state }, { provider, now: NOW + 40_000, memoryKey: null });
    history.push({ speaker: "interviewer", text: t2.turn.text }, { speaker: "candidate", text: SPOKEN.projects[2] });
    await runAdaptiveTurn({ ...HR, history, state: t2.state }, { provider, now: NOW + 80_000, memoryKey: null });
    expect(brief).toContain("ASKED ALREADY THIS INTERVIEW");
    expect(brief).toContain("which parts did you build");
    expect(brief).toContain("Already established on this ground");
    expect(brief).toContain("It answered the question");
  });
});

describe("repetition — moves after a complete answer", () => {
  function afterAnswer(answer: string, clarifies = 0) {
    let s = commit(initState({ sid: "r", now: NOW, ...REQ }), { kind: "open", text: "Tell me about a project you built?", source: "fallback" }, NOW);
    s = { ...s, thread: { ...s.thread, clarifies } };
    const history: HistoryEntry[] = [
      { speaker: "interviewer", text: "Tell me about a project you built?" },
      { speaker: "candidate", text: answer },
    ];
    const r = ingest(s, history, NOW + 1000);
    return { state: r.state, history, last: r.analyses[0], ctx: moveContext(r.state, history, r.analyses[0], NOW + 1000) };
  }

  it("a vague answer earns one request for specifics; a second is refused and moving on is allowed", () => {
    const first = afterAnswer("It was good, we did many things and it worked well mostly.");
    expect(validateMove({ action: "clarify", competency: "projects" }, first.ctx).ok).toBe(true);
    const second = afterAnswer("Still, we did lots of things and it went well overall I think.", 1);
    expect(validateMove({ action: "clarify", competency: "projects" }, second.ctx).ok).toBe(false);
    expect(validateMove({ action: "switch_competency", competency: "java" }, second.ctx).ok).toBe(true);
    expect(decide(second.state, second.history, second.last, NOW + 1000).recommended?.action).not.toBe("clarify");
  });

  it("a complete answer is not challenged and not read as an overclaim", () => {
    const r = afterAnswer(SPOKEN.projects[0]);
    const rec = decide(r.state, r.history, r.last, NOW + 1000).recommended;
    expect(rec?.action).not.toBe("challenge");
    expect(rec?.action).not.toBe("clarify");
  });

  it("a resume claim discussed in an adequate answer counts as supported, so it is not probed again", () => {
    const r = afterAnswer(SPOKEN.projects[0]);
    const claim = r.state.claims.find((c) => c.area === "project:campus cart");
    expect(claim?.status).toBe("supported");
    expect(validateMove({ action: "probe_resume", target: claim!.id }, r.ctx).ok).toBe(false);
  });
});

describe("repetition — retries and reconnects", () => {
  it("a retried request (same history, same state) does not double-count the turn or duplicate memory", async () => {
    const history: HistoryEntry[] = [];
    const t1 = await runAdaptiveTurn({ ...REQ, history }, { provider: mockProvider, now: NOW, memoryKey: null });
    history.push({ speaker: "interviewer", text: t1.turn.text }, { speaker: "candidate", text: SPOKEN.projects[0] });
    const a = await runAdaptiveTurn({ ...REQ, history, state: t1.state }, { provider: mockProvider, now: NOW + 40_000, memoryKey: null });
    const b = await runAdaptiveTurn({ ...REQ, history, state: t1.state }, { provider: mockProvider, now: NOW + 41_000, memoryKey: null });
    // Same decision either way, and the lost attempt leaves no trace in the retry's state.
    expect(b.turn.text).toBe(a.turn.text);
    history.push({ speaker: "interviewer", text: b.turn.text }, { speaker: "candidate", text: SPOKEN.projects[1] });
    const c = await runAdaptiveTurn({ ...REQ, history, state: b.state }, { provider: mockProvider, now: NOW + 80_000, memoryKey: null });
    expect(c.turn.text).not.toBe(b.turn.text);
    expect(findRepeats([t1.turn.text, b.turn.text, c.turn.text]).exact).toEqual([]);
  });

  it("a reconnect with no state token rebuilds from the transcript and still asks nothing twice", async () => {
    const run = await drive(mockProvider, 6);
    const res = await runAdaptiveTurn({ ...REQ, history: run.history }, { provider: mockProvider, now: NOW + 500_000, memoryKey: null });
    const all = [...run.questions, res.turn.text];
    expect(findRepeats(all).exact).toEqual([]);
    expect(findRepeats(all).reworded).toEqual([]);
    expect(typeof res.state).toBe("string");
  });
});

describe("repetition — a round does not get stuck on one competency", () => {
  const GENERIC = "I think the main thing is I try to understand the problem first and then break it into smaller steps, that is what I did in my college projects too.";
  const STORY = "When I had to learn Docker for the deployment I had about four days. I skipped the theory, followed one official tutorial, broke the setup twice and fixed it, and by the deadline the app was running in a container.";

  it("an HR round whose candidate repeats one generic story still reaches most required competencies", async () => {
    const HR = { role: "hr-behavioural" as const, roundType: "hr" as const, candidateName: "Ravi" };
    const history: HistoryEntry[] = [];
    let state: string | undefined;
    const threads: string[] = [];
    for (let t = 0; t < 16; t++) {
      const res = await runAdaptiveTurn({ ...HR, history, ...(state ? { state } : {}) }, { provider: mockProvider, now: NOW + t * 40_000, memoryKey: null });
      state = res.state;
      if (res.view.current) threads.push(res.view.current);
      history.push({ speaker: "interviewer", text: res.turn.text });
      if (res.turn.done) break;
      history.push({ speaker: "candidate", text: t % 3 === 0 ? STORY : GENERIC });
    }
    const distinct = new Set(threads);
    expect(distinct.size).toBeGreaterThanOrEqual(4);
    // Never more than three consecutive turns on the same competency.
    let run = 1;
    for (let i = 1; i < threads.length; i++) {
      run = threads[i] === threads[i - 1] ? run + 1 : 1;
      expect(run).toBeLessThanOrEqual(3);
    }
  });
});
