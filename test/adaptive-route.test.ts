import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateInput, GeneratedTurn } from "@/lib/llm/provider";

// /api/interview driving the adaptive engine: signed state round-trips, the
// model's proposed move is validated before it is used, a tampered token is
// never trusted, and a model outage leaves an adaptive (not scripted-bank)
// interview. The provider is a fake adaptive one; the route, orchestrator,
// engine and token are real.

const fake = vi.hoisted(() => ({
  gen: null as null | ((input: GenerateInput) => Promise<GeneratedTurn | null>),
  calls: [] as GenerateInput[],
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ userId: null }) }));
vi.mock("@/lib/llm", () => ({
  getProvider: () => ({
    name: "fake",
    adaptive: true,
    async nextTurn() {
      throw new Error("the legacy whole-turn path must not run for an adaptive provider");
    },
    async generate(input: GenerateInput) {
      fake.calls.push(input);
      return fake.gen ? fake.gen(input) : null;
    },
  }),
}));

import { POST } from "@/app/api/interview/route";
import { ProviderError } from "@/lib/llm/provider";

const base = { role: "java-sde-fresher", roundType: "technical", candidateName: "Asha" };
const STRONG =
  "I built a marketplace in Spring Boot because students needed one place to trade books; I designed the REST API and the PostgreSQL schema, and it served 300 users.";

function post(body: unknown): Request {
  return new Request("http://localhost/api/interview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function open() {
  fake.gen = async () => ({ text: "Hi Asha, I'm Haris, an AI interviewer. What's a project you built recently?", move: null, note: null, done: false });
  const r = await (await POST(post({ ...base, history: [] }))).json();
  return { r, history: [{ speaker: "interviewer", text: r.turn.text }, { speaker: "candidate", text: STRONG }] };
}

beforeEach(() => {
  fake.gen = null;
  fake.calls = [];
});

describe("adaptive /api/interview", () => {
  it("opens with signed state and a coverage view, then carries the state into the next turn", async () => {
    const { r, history } = await open();
    expect(r.turn.type).toBe("greeting");
    expect(typeof r.state).toBe("string");
    expect(r.view.competencies.map((c: { id: string }) => c.id)).toContain("java");

    fake.gen = async (input) => {
      expect(input.kind).toBe("move");
      expect(input.brief).toContain("YOUR MOVE");
      return { text: "Nice. Why Spring Boot rather than plain servlets there?", move: { action: "follow_up", competency: "projects" }, note: "strong start", done: false };
    };
    const r2 = await (await POST(post({ ...base, history, state: r.state }))).json();
    expect(r2.turn.type).toBe("followup");
    expect(r2.turn.scripted).toBeUndefined();
    expect(r2.state).not.toBe(r.state);
    expect(r2.view.competencies.find((c: { id: string }) => c.id === "projects").coverage).toBeGreaterThan(0);
  });

  it("refuses an invalid proposed move and regenerates with the recommended move decided", async () => {
    const { r, history } = await open();
    fake.gen = async (input) =>
      input.forcedMove
        ? { text: "Tell me more about how you designed that schema?", move: null, note: null, done: false }
        : { text: "Thanks, that's everything from me. Any questions?", move: { action: "wrap" }, note: null, done: false };
    const r2 = await (await POST(post({ ...base, history, state: r.state }))).json();
    expect(fake.calls).toHaveLength(3); // open, refused wrap, regeneration
    expect(fake.calls[2].forcedMove).toBeTruthy();
    expect(fake.calls[2].forcedMove?.action).not.toBe("wrap");
    expect(r2.turn.text).toContain("schema");
  });

  it("never trusts a tampered state token — it rebuilds from the transcript instead", async () => {
    const { r, history } = await open();
    const forged = r.state.slice(0, -2) + (r.state.endsWith("A") ? "BB" : "AA");
    fake.gen = async () => ({ text: "Okay. Walk me through the API design?", move: { action: "follow_up", competency: "projects" }, note: null, done: false });
    const res = await POST(post({ ...base, history, state: forged }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.state).toBe("string");
    expect(body.state).not.toBe(forged);
  });

  it("keeps the interview adaptive when the model fails (429): the deterministic interviewer executes a valid move", async () => {
    const { r, history } = await open();
    fake.gen = async () => {
      throw new ProviderError("groq_429: rate limited", "rate_limited");
    };
    const res = await POST(post({ ...base, history, state: r.state }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turn.scripted).toBe(true);
    expect(body.turn.text.length).toBeGreaterThan(10);
    expect(typeof body.state).toBe("string");
  });

  it("streams the adaptive turn with state and view on the turn event", async () => {
    const { r, history } = await open();
    fake.gen = async () => ({ text: "Got it. What did the schema look like?", move: { action: "follow_up", competency: "projects" }, note: null, done: false });
    const raw = await (await POST(post({ ...base, history, state: r.state, stream: true }))).text();
    const events = raw
      .split("\n\n")
      .filter(Boolean)
      .map((f) => JSON.parse(f.slice(6)));
    const turn = events.find((e) => e.kind === "turn");
    expect(events[0].kind).toBe("text");
    expect(typeof turn.state).toBe("string");
    expect(turn.view.roundType).toBe("technical");
  });
});
