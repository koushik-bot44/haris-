import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InterviewRequest } from "@/lib/types";

// The provider half of "never ask the same question twice": what actually gets
// recorded when the interviewer speaks, what reaches the prompt, and — the
// thing that used to be wrong — that none of it is on the turn's critical path.

const state = vi.hoisted(() => ({
  reply: 'So what happens when you type a URL and press enter?\n@@CTRL {"type":"question","questionIndex":2,"asked":true,"done":false}',
  prompts: [] as string[],
}));

vi.mock("@/lib/llm/chat", () => ({
  chatConfig: () => ({
    backend: "groq",
    baseUrl: "https://example.invalid",
    apiKey: "k",
    model: "test-model",
    fallbackModel: null,
    headers: {},
  }),
  isReasoningModel: () => false,
  chatComplete: vi.fn(async (prompt: string) => {
    state.prompts.push(prompt);
    return state.reply;
  }),
}));

import { chatComplete } from "@/lib/llm/chat";
import { apiProvider } from "@/lib/llm/api-provider";
import { askedTagFor, resetMemoryCaches } from "@/lib/memory";

const SUBJECT = "guest-11111111-2222-3333";

function req(history: InterviewRequest["history"]): InterviewRequest {
  return { role: "general", roundType: "hr", candidateName: "Hari", history };
}

const MID_INTERVIEW: InterviewRequest["history"] = [
  { speaker: "interviewer", text: "Hi Hari, good to meet you." },
  { speaker: "candidate", text: "Hello, happy to be here and ready to get started with the interview today." },
];

/** Requests the stubbed fetch saw, split by Supermemory endpoint. */
function smCalls(spy: ReturnType<typeof vi.fn>) {
  const seen = spy.mock.calls as unknown as [string, RequestInit][];
  const parse = (c: [string, RequestInit]) => JSON.parse(String(c[1].body)) as Record<string, unknown>;
  return {
    searches: seen.filter((c) => c[0].endsWith("/v3/search")).map(parse),
    writes: seen.filter((c) => c[0].endsWith("/v3/documents")).map(parse),
  };
}

function searchBody(contents: string[]) {
  return { ok: true, json: async () => ({ results: contents.map((c) => ({ chunks: [{ content: c }] })) }) };
}

beforeEach(() => {
  vi.stubEnv("SUPERMEMORY_API_KEY", "test-key");
  resetMemoryCaches();
  state.prompts = [];
  vi.mocked(chatComplete).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetMemoryCaches();
});

describe("recording what the interviewer asked", () => {
  it("writes the question a model turn actually put to the candidate", async () => {
    const fetchSpy = vi.fn(async () => searchBody([]));
    vi.stubGlobal("fetch", fetchSpy);
    await apiProvider.nextTurn(req(MID_INTERVIEW), { memoryKey: SUBJECT });
    const { writes } = smCalls(fetchSpy);
    const asked = writes.filter((w) => (w.containerTags as string[])[0] === askedTagFor(SUBJECT, "hr"));
    expect(asked).toHaveLength(1);
    expect(String(asked[0].content)).toContain("So what happens when you type a URL and press enter?");
  });

  it("records nothing from a speculative pre-fetch — most are thrown away", async () => {
    const fetchSpy = vi.fn(async () => searchBody([]));
    vi.stubGlobal("fetch", fetchSpy);
    await apiProvider.nextTurn(req(MID_INTERVIEW), { memoryKey: SUBJECT, speculative: true });
    expect(smCalls(fetchSpy).writes).toHaveLength(0);
  });

  it("records nothing when there is no memory subject at all", async () => {
    const fetchSpy = vi.fn(async () => searchBody([]));
    vi.stubGlobal("fetch", fetchSpy);
    await apiProvider.nextTurn(req(MID_INTERVIEW), { memoryKey: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not record a turn that only reacted, without asking anything", async () => {
    state.reply = 'That makes sense, and I would have done the same.\n@@CTRL {"type":"reply","questionIndex":0,"asked":false,"done":false}';
    const fetchSpy = vi.fn(async () => searchBody([]));
    vi.stubGlobal("fetch", fetchSpy);
    await apiProvider.nextTurn(req(MID_INTERVIEW), { memoryKey: SUBJECT });
    const asked = smCalls(fetchSpy).writes.filter((w) => (w.containerTags as string[])[0] === askedTagFor(SUBJECT, "hr"));
    expect(asked).toHaveLength(0);
    state.reply = 'So what happens when you type a URL and press enter?\n@@CTRL {"type":"question","questionIndex":2,"asked":true,"done":false}';
  });
});

describe("recall is never on the turn's critical path", () => {
  it("primes memory on the opening turn, which the client pre-fetches during the mic check", async () => {
    const fetchSpy = vi.fn(async () => searchBody([]));
    vi.stubGlobal("fetch", fetchSpy);
    await apiProvider.nextTurn(req([]), { memoryKey: SUBJECT });
    // Both kinds of recall go and get themselves while the greeting is written.
    await vi.waitFor(() => expect(smCalls(fetchSpy).searches.length).toBeGreaterThanOrEqual(2));
  });

  it("calls the model without waiting for a search that has not come back", async () => {
    // The old code awaited recallCandidate() right here, so the first turn of
    // every session paid a search before the model was even reached.
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.endsWith("/v3/search") ? pending : { ok: true, json: async () => ({}) })),
    );
    const turn = apiProvider.nextTurn(req(MID_INTERVIEW), { memoryKey: SUBJECT });
    // If recall were awaited this would never fire until the search resolved.
    await vi.waitFor(() => expect(chatComplete).toHaveBeenCalled());
    release(searchBody([]));
    expect((await turn).text).toContain("type a URL");
  });

  it("runs the turn with no memory rather than blocking when the cache is cold", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Promise(() => {})));
    await apiProvider.nextTurn(req(MID_INTERVIEW), { memoryKey: SUBJECT });
    expect(state.prompts[0]).not.toContain("ALREADY ASKED");
  });
});

describe("what reaches the prompt once memory is warm", () => {
  it("puts the already-asked questions in front of the model as a prohibition", async () => {
    const stored = 'Asked Hari this hr interview question: "Where do you see yourself in five years?"';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/v3/search") ? searchBody([stored]) : { ok: true, json: async () => ({}) },
      ),
    );
    // Turn one warms the cache; turn two is the one that can use it.
    await apiProvider.nextTurn(req([]), { memoryKey: SUBJECT });
    await vi.waitFor(() => expect(smCalls(vi.mocked(fetch)).searches.length).toBeGreaterThanOrEqual(2));
    await apiProvider.nextTurn(req(MID_INTERVIEW), { memoryKey: SUBJECT });
    const prompt = state.prompts[state.prompts.length - 1];
    expect(prompt).toContain("ALREADY ASKED");
    expect(prompt).toContain("Where do you see yourself in five years?");
    expect(prompt).toContain("in any rewording");
  });

  it("carries recalled background too, and says neither block when there is nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/v3/search")
          ? searchBody(["In a hr practice interview, Hari said: I built a payment reconciliation engine."])
          : { ok: true, json: async () => ({}) },
      ),
    );
    await apiProvider.nextTurn(req([]), { memoryKey: SUBJECT });
    await vi.waitFor(() => expect(smCalls(vi.mocked(fetch)).searches.length).toBeGreaterThanOrEqual(2));
    await apiProvider.nextTurn(req(MID_INTERVIEW), { memoryKey: SUBJECT });
    expect(state.prompts[state.prompts.length - 1]).toContain("FROM EARLIER SESSIONS WITH THIS CANDIDATE");
  });
});
