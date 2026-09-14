import { afterEach, describe, expect, it, vi } from "vitest";
import { chatConfig, chatLabel } from "@/lib/llm/chat";

const KEYS = [
  "LLM_PROVIDER",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "GROQ_MODEL",
  "OPENAI_MODEL",
  "GEMINI_MODEL",
];

function env(vars: Record<string, string>) {
  for (const k of KEYS) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

describe("chatConfig (LLM backend selection)", () => {
  it("nothing configured → null (the scripted brain)", () => {
    env({});
    expect(chatConfig()).toBeNull();
    expect(chatLabel()).toBeNull();
  });

  it("auto-detects Groq first (fastest for voice) when several keys exist", () => {
    env({ GROQ_API_KEY: "gsk_1", OPENAI_API_KEY: "sk_1" });
    const cfg = chatConfig()!;
    expect(cfg.backend).toBe("groq");
    expect(cfg.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(cfg.model).toBe("openai/gpt-oss-120b");
    expect(cfg.fallbackModel).toBe("openai/gpt-oss-20b");
  });

  it("recognises reasoning-class models", async () => {
    const { isReasoningModel } = await import("@/lib/llm/chat");
    expect(isReasoningModel("openai/gpt-oss-120b")).toBe(true);
    expect(isReasoningModel("gpt-5.6-luna")).toBe(true);
    expect(isReasoningModel("qwen/qwen3.6-27b")).toBe(true);
    expect(isReasoningModel("llama-3.3-70b-versatile")).toBe(false);
    expect(isReasoningModel("gemini-2.5-flash")).toBe(false);
  });

  it("heals an unavailable model from the provider's /models roster", async () => {
    env({ GROQ_API_KEY: "gsk_1", GROQ_MODEL: "llama-3.3-70b-versatile" });
    const { chatComplete } = await import("@/lib/llm/chat");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "whisper-large-v3" }, { id: "openai/gpt-oss-20b" }, { id: "qwen/qwen3.6-27b" }] }), { status: 200 });
        }
        const body = JSON.parse(String(init?.body)) as { model: string };
        calls.push(body.model);
        if (body.model === "llama-3.3-70b-versatile") {
          return new Response(JSON.stringify({ error: { message: "The model `llama-3.3-70b-versatile` does not exist or you do not have access to it." } }), { status: 404 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "hello from " + body.model } }] }), { status: 200 });
      }),
    );
    try {
      const text = await chatComplete("hi");
      // The configured model 404s → the roster is consulted → the best
      // preferred model present (qwen3.6 outranks gpt-oss-20b) is used.
      expect(calls).toEqual(["llama-3.3-70b-versatile", "qwen/qwen3.6-27b"]);
      expect(text).toBe("hello from qwen/qwen3.6-27b");
      // …and remembered: the next call goes straight to it.
      expect(chatConfig()!.model).toBe("qwen/qwen3.6-27b");
      await chatComplete("again");
      expect(calls[calls.length - 1]).toBe("qwen/qwen3.6-27b");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an explicit LLM_PROVIDER wins over auto-detection", () => {
    env({ GROQ_API_KEY: "gsk_1", OPENAI_API_KEY: "sk_1", LLM_PROVIDER: "openai" });
    expect(chatConfig()!.backend).toBe("openai");
    expect(chatLabel()).toMatch(/^openai\//);
  });

  it("an explicit provider without its key is a config error → null", () => {
    env({ GROQ_API_KEY: "gsk_1", LLM_PROVIDER: "openai" });
    expect(chatConfig()).toBeNull();
  });

  it("mock / claude-cli are never cloud backends", () => {
    env({ GROQ_API_KEY: "gsk_1", LLM_PROVIDER: "mock" });
    expect(chatConfig()).toBeNull();
    env({ GROQ_API_KEY: "gsk_1", LLM_PROVIDER: "claude-cli" });
    expect(chatConfig()).toBeNull();
  });

  it("Gemini rides its OpenAI-compatible endpoint and accepts GOOGLE_API_KEY", () => {
    env({ GOOGLE_API_KEY: "g_1" });
    const cfg = chatConfig()!;
    expect(cfg.backend).toBe("gemini");
    expect(cfg.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(cfg.model).toBe("gemini-2.5-flash");
  });

  it("model overrides: provider-specific beats generic beats default", () => {
    env({ GROQ_API_KEY: "gsk_1", LLM_MODEL: "generic-model" });
    expect(chatConfig()!.model).toBe("generic-model");
    env({ GROQ_API_KEY: "gsk_1", LLM_MODEL: "generic-model", GROQ_MODEL: "specific-model" });
    expect(chatConfig()!.model).toBe("specific-model");
  });

  it("custom needs base URL, key and model; trailing slashes are trimmed", () => {
    env({ LLM_PROVIDER: "custom", LLM_API_KEY: "k", LLM_BASE_URL: "http://localhost:11434/v1/", LLM_MODEL: "llama3" });
    const cfg = chatConfig()!;
    expect(cfg.backend).toBe("custom");
    expect(cfg.baseUrl).toBe("http://localhost:11434/v1");
    env({ LLM_PROVIDER: "custom", LLM_API_KEY: "k", LLM_BASE_URL: "http://localhost:11434/v1" });
    expect(chatConfig()).toBeNull(); // no model
  });

  it("OpenRouter carries attribution headers", () => {
    env({ OPENROUTER_API_KEY: "or_1" });
    const cfg = chatConfig()!;
    expect(cfg.backend).toBe("openrouter");
    expect(cfg.headers["X-Title"]).toBeTruthy();
  });
});
