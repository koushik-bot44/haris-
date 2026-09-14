import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// How the interviewer's brain behaves when Groq says "slow down".
//
// Groq's free tier meters every model at 8,000 tokens per minute and a turn
// costs ~2,000-2,700, so 429s are routine — and the bucket refills
// continuously, so the 429 usually asks for well under a second. Switching to
// the fallback model on the FIRST 429 (the old behaviour) handed the candidate
// a different, smaller interviewer for a turn and then the bigger one again.
// These tests pin: a short wait keeps the main model; a long ask or a second
// 429 goes to the fallback; a client abort never waits.

const calls = vi.hoisted(() => [] as { model: string; at: number }[]);

vi.mock("@/lib/abort", () => ({
  timeoutSignal: (_ms: number, signal?: AbortSignal) => signal ?? new AbortController().signal,
}));

import { chatComplete, type ChatConfig } from "@/lib/llm/chat";

const cfg: ChatConfig = {
  backend: "groq",
  baseUrl: "https://groq.invalid/openai/v1",
  apiKey: "k",
  model: "openai/gpt-oss-120b",
  fallbackModel: "openai/gpt-oss-20b",
  headers: {},
};

type Scripted = { status: number; body: unknown; headers?: Record<string, string> };

function stubFetch(script: Scripted[]) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const s = script[Math.min(i++, script.length - 1)];
      calls.push({ model: (JSON.parse(String(init.body)) as { model: string }).model, at: Date.now() });
      return new Response(JSON.stringify(s.body), {
        status: s.status,
        headers: { "content-type": "application/json", ...(s.headers ?? {}) },
      });
    }),
  );
}

const ok = (text: string): Scripted => ({ status: 200, body: { choices: [{ message: { content: text } }] } });
const limited = (msg: string, headers?: Record<string, string>): Scripted => ({
  status: 429,
  body: { error: { message: msg } },
  headers,
});

beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chatComplete — a short rate-limit wait keeps the main model", () => {
  it("waits the provider's sub-second ask and retries the SAME model", async () => {
    stubFetch([limited("Rate limit reached. Please try again in 350ms."), ok("still the big model")]);
    const p = chatComplete("hi", {}, cfg);
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toBe("still the big model");
    expect(calls.map((c) => c.model)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
  });

  it("reads a whole-second retry-after header when the body says nothing", async () => {
    stubFetch([limited("Rate limit reached.", { "retry-after": "1" }), ok("back on the big model")]);
    const p = chatComplete("hi", {}, cfg);
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(p).resolves.toBe("back on the big model");
    expect(calls.map((c) => c.model)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
  });

  it("does NOT wait for a long ask — goes straight to the fallback model", async () => {
    stubFetch([limited("Please try again in 8.2s."), ok("fallback spoke")]);
    const p = chatComplete("hi", {}, cfg);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe("fallback spoke");
    expect(calls.map((c) => c.model)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  });

  it("a second 429 after the wait falls to the fallback model", async () => {
    stubFetch([limited("try again in 200ms"), limited("try again in 900ms"), ok("fallback spoke")]);
    const p = chatComplete("hi", {}, cfg);
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBe("fallback spoke");
    expect(calls.map((c) => c.model)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  });

  it("a 429 with no timing information behaves as before: fallback at once", async () => {
    stubFetch([limited("Rate limit reached."), ok("fallback spoke")]);
    const p = chatComplete("hi", {}, cfg);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe("fallback spoke");
    expect(calls.map((c) => c.model)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  });

  it("never waits on behalf of a client that has already gone away", async () => {
    stubFetch([limited("try again in 300ms"), ok("nobody is listening")]);
    const ac = new AbortController();
    ac.abort();
    const p = chatComplete("hi", { signal: ac.signal }, cfg);
    await vi.advanceTimersByTimeAsync(10);
    // Aborted: no wait, and the fallback path throws rather than spending a
    // second request on a dead connection… or resolves immediately — either
    // way it must not sit in the 300ms sleep.
    await Promise.allSettled([p]);
    const waited = calls.length >= 2 ? calls[1].at - calls[0].at : 0;
    expect(waited).toBeLessThan(200);
  });

  it("a non-429 failure is not retried on the same model", async () => {
    stubFetch([{ status: 500, body: { error: { message: "boom" } } }]);
    await expect(chatComplete("hi", {}, cfg)).rejects.toThrow(/groq_500/);
    expect(calls.map((c) => c.model)).toEqual(["openai/gpt-oss-120b"]);
  });
});

describe("chatComplete — reasoning switches per Groq model family", () => {
  /** The JSON body of the last request the stub saw. */
  const lastBody = () => {
    const f = fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    const [, init] = f.mock.calls[f.mock.calls.length - 1];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  };

  it("qwen gets reasoning_effort 'none' — the only cheap value Groq accepts for it", async () => {
    // Measured: with thinking on, qwen3.6-27b spent a whole 900-token budget on
    // <think> and returned empty content; every background brain fell to the
    // heuristics. Groq rejects "low" for qwen ("must be one of none or default").
    stubFetch([ok("{}")]);
    await chatComplete("score this", { model: "qwen/qwen3.6-27b" }, cfg);
    expect(lastBody().reasoning_effort).toBe("none");
    expect(lastBody().reasoning_format).toBeUndefined();
  });

  it("gpt-oss keeps low effort with the thinking hidden", async () => {
    stubFetch([ok("{}")]);
    await chatComplete("hi", {}, cfg);
    expect(lastBody().reasoning_effort).toBe("low");
    expect(lastBody().reasoning_format).toBe("hidden");
  });

  it("a non-reasoning model gets no reasoning parameters at all", async () => {
    stubFetch([ok("{}")]);
    await chatComplete("hi", { model: "llama-3.3-70b-versatile" }, cfg);
    expect(lastBody().reasoning_effort).toBeUndefined();
    expect(lastBody().reasoning_format).toBeUndefined();
  });
});
