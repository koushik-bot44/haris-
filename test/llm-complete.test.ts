import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The background brains (scoring, guidance, résumé, GD) must run on a
// DIFFERENT model from the interviewer. On Groq's free tier every model has its
// own 8,000 tokens/minute bucket, and an interviewer turn costs ~2,000-2,700 of
// them; scoring once per answer on the same model drained the interviewer's
// bucket, and the round silently fell to the fallback model and then to the
// fixture bank. These tests pin the split and its safety net.

const calls = vi.hoisted(() => [] as { model?: string; cfgModel: string }[]);
const behaviour = vi.hoisted(() => ({ failBackground: null as null | { status?: number; message: string } }));

vi.mock("@/lib/llm/chat", () => {
  const cfg = {
    backend: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "k",
    model: "openai/gpt-oss-120b",
    fallbackModel: "openai/gpt-oss-20b",
    headers: {},
  };
  class ProviderError extends Error {
    kind: string;
    status?: number;
    constructor(message: string, kind: string, status?: number) {
      super(message);
      this.kind = kind;
      this.status = status;
    }
  }
  return {
    chatConfig: () => cfg,
    chatComplete: vi.fn(async (_prompt: string, opts: { model?: string }, c: typeof cfg) => {
      calls.push({ model: opts.model, cfgModel: c.model });
      if (opts.model && behaviour.failBackground) {
        const e = new ProviderError(behaviour.failBackground.message, "unavailable", behaviour.failBackground.status);
        throw e;
      }
      return `reply from ${opts.model ?? c.model}`;
    }),
  };
});
vi.mock("@/lib/llm/provider", () => ({
  ProviderError: class ProviderError extends Error {},
}));
vi.mock("@/lib/llm/cli-runner", () => ({ cliAllowed: () => false, runClaude: vi.fn() }));

import { llmText } from "@/lib/llm/complete";

beforeEach(() => {
  calls.length = 0;
  behaviour.failBackground = null;
  vi.stubEnv("LLM_BACKGROUND_MODEL", "");
  vi.stubEnv("GROQ_BACKGROUND_MODEL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("llmText — background work stays off the interviewer's token bucket", () => {
  it("uses the background model, not the interviewer's", async () => {
    await expect(llmText("score this")).resolves.toBe("reply from qwen/qwen3.6-27b");
    expect(calls).toEqual([{ model: "qwen/qwen3.6-27b", cfgModel: "openai/gpt-oss-120b" }]);
  });

  it("honours an explicit *_BACKGROUND_MODEL override", async () => {
    vi.stubEnv("GROQ_BACKGROUND_MODEL", "llama-3.1-8b-instant");
    await llmText("score this");
    expect(calls[0].model).toBe("llama-3.1-8b-instant");
  });

  it("an override equal to the interviewer's model restores the single-bucket behaviour", async () => {
    vi.stubEnv("LLM_BACKGROUND_MODEL", "openai/gpt-oss-120b");
    await llmText("score this");
    // No model override at all — plain chatComplete on the configured model.
    expect(calls).toEqual([{ model: undefined, cfgModel: "openai/gpt-oss-120b" }]);
  });

  it("a rate-limited background model falls back to the interviewer's model for THAT call only", async () => {
    behaviour.failBackground = { status: 429, message: "groq_429" };
    await expect(llmText("score this")).resolves.toBe("reply from openai/gpt-oss-120b");
    expect(calls.map((c) => c.model)).toEqual(["qwen/qwen3.6-27b", undefined]);

    // Next call tries the background model again — a 429 is transient.
    behaviour.failBackground = null;
    calls.length = 0;
    await llmText("score this");
    expect(calls.map((c) => c.model)).toEqual(["qwen/qwen3.6-27b"]);
  });

  it("a background model the account cannot use is remembered and never retried", async () => {
    vi.stubEnv("GROQ_BACKGROUND_MODEL", "gone/model-x");
    behaviour.failBackground = { status: 404, message: "groq_404: model not found" };
    await expect(llmText("score this")).resolves.toBe("reply from openai/gpt-oss-120b");
    calls.length = 0;
    behaviour.failBackground = null;
    await llmText("score again");
    // Straight to the interviewer's model — no doomed round trip.
    expect(calls.map((c) => c.model)).toEqual([undefined]);
  });

  it("the caller's own abort is not retried on the other model", async () => {
    const ac = new AbortController();
    ac.abort();
    behaviour.failBackground = { message: "groq network error" };
    await expect(llmText("score this", { signal: ac.signal })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
