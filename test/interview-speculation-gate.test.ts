import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InterviewRequest, InterviewerTurn } from "@/lib/types";

// Mid-answer speculation is a token-budget decision made by the SERVER.
//
// The client pre-fetches a guess at the next turn while the candidate is still
// talking. Every guess is a full interviewer prompt (~2,000-2,700 tokens,
// measured) and most are discarded, so on a metered brain it roughly doubles
// the spend per turn. Groq's free tier meters each model at 8,000 tokens per
// minute; a live session showed the main model rate-limited on 3 of 5 calls,
// each time dropping the candidate to a smaller model or the fixture bank. So
// on Groq the guess is refused with { turn: null } — which the client already
// treats as "no speculation available" — while the OPENING pre-fetch (empty
// history, one request during the mic check) is always served.

const state = vi.hoisted(() => ({
  backend: "groq" as string | null,
  calls: [] as { history: unknown[]; speculative?: boolean }[],
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ userId: null }) }));
vi.mock("@/lib/llm/chat", () => ({
  chatConfig: () => (state.backend ? { backend: state.backend, model: "m" } : null),
}));
vi.mock("@/lib/llm", () => ({
  getProvider: () => ({
    name: "test-provider",
    nextTurn(req: InterviewRequest, opts?: { speculative?: boolean }): Promise<InterviewerTurn> {
      state.calls.push({ history: req.history, speculative: opts?.speculative });
      return Promise.resolve({ type: "question", text: "A real turn?", questionIndex: 1, done: false, asked: true });
    },
  }),
}));

import { POST } from "@/app/api/interview/route";

const MID_ROUND = [
  { speaker: "interviewer", text: "Hello Hari, tell me about yourself." },
  { speaker: "candidate", text: "Sure — I am a final-year CSE student who built a voice interview simulator." },
];

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/interview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "general", roundType: "hr", candidateName: "Hari", ...body }),
    }),
  );
}

beforeEach(() => {
  state.backend = "groq";
  state.calls.length = 0;
  vi.stubEnv("LLM_SPECULATE", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/interview — speculation gate", () => {
  it("refuses a mid-answer speculative guess on Groq with { turn: null }, spending nothing", async () => {
    const res = await post({ history: MID_ROUND, speculative: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { turn: unknown; skipped?: string };
    expect(body.turn).toBeNull();
    expect(body.skipped).toBe("metered_backend");
    expect(state.calls).toHaveLength(0); // the brain was never asked
  });

  it("still serves the OPENING pre-fetch (empty history) on Groq", async () => {
    const res = await post({ history: [], speculative: true });
    const body = (await res.json()) as { turn: InterviewerTurn | null };
    expect(body.turn?.text).toBe("A real turn?");
    expect(state.calls).toHaveLength(1);
  });

  it("a REAL (non-speculative) turn on Groq is never gated", async () => {
    const res = await post({ history: MID_ROUND });
    const body = (await res.json()) as { turn: InterviewerTurn | null };
    expect(body.turn?.text).toBe("A real turn?");
    expect(state.calls).toEqual([{ history: MID_ROUND, speculative: false }]);
  });

  it("speculates freely on an unmetered brain", async () => {
    state.backend = "openai";
    const res = await post({ history: MID_ROUND, speculative: true });
    const body = (await res.json()) as { turn: InterviewerTurn | null };
    expect(body.turn?.text).toBe("A real turn?");
    expect(state.calls[0].speculative).toBe(true);
  });

  it("speculates when no cloud brain is configured at all (scripted/mock cost nothing)", async () => {
    state.backend = null;
    const res = await post({ history: MID_ROUND, speculative: true });
    expect(((await res.json()) as { turn: unknown }).turn).not.toBeNull();
  });

  it("LLM_SPECULATE=1 forces speculation on even for Groq", async () => {
    vi.stubEnv("LLM_SPECULATE", "1");
    const res = await post({ history: MID_ROUND, speculative: true });
    expect(((await res.json()) as { turn: unknown }).turn).not.toBeNull();
    expect(state.calls).toHaveLength(1);
  });

  it("LLM_SPECULATE=0 forces it off even for an unmetered brain", async () => {
    state.backend = "openai";
    vi.stubEnv("LLM_SPECULATE", "0");
    const res = await post({ history: MID_ROUND, speculative: true });
    expect(((await res.json()) as { turn: unknown }).turn).toBeNull();
    expect(state.calls).toHaveLength(0);
  });

  it("a refused guess still mints the guest cookie so identity is not delayed a turn", async () => {
    const res = await post({ history: MID_ROUND, speculative: true });
    expect(res.headers.get("set-cookie")).toMatch(/pds_guest=/);
  });
});
