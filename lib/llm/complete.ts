// Text completion for the BACKGROUND brains — scoring, resume analysis,
// career guidance, the GD debate. One place decides which brain is on:
//   cloud chat backend (lib/llm/chat.ts) when a key exists,
//   the local Claude CLI when it is the selected dev provider,
//   otherwise nothing — callers fall back to their deterministic heuristics.
// Every route labels its response with `llmSource()` so a scripted result can
// be told apart from a model result in the UI ("basic check · brain offline").

import { chatComplete, chatConfig, type ChatBackend, type ChatConfig } from "@/lib/llm/chat";
import { ProviderError } from "@/lib/llm/provider";
import { cliAllowed, runClaude } from "@/lib/llm/cli-runner";

export type LlmSource = ChatBackend | "claude-cli" | "heuristic";

const BACKGROUND_TIMEOUT_MS = 45_000;

/** The model the background brains run on, per backend — DIFFERENT from the
 * interviewer's, on purpose.
 *
 * Measured against Groq's free tier (2026-08-25): every model has its OWN
 * 8,000 tokens-per-minute bucket, and an interviewer turn costs ~2,000-2,700 of
 * them. Scoring runs once per answer on the same account, so with everything on
 * one model a candidate who answered every 30 s drained the interviewer's bucket
 * and the round silently dropped to the fallback model, then to the fixture
 * bank — the log showed "main model rate-limited" on 3 of 5 calls in one short
 * session. Moving the background work to its own model gives the interviewer
 * the whole bucket and costs the background brains nothing they care about:
 * they are not on the latency path, and qwen3.6-27b answered the same probes in
 * ~110 ms. Override with LLM_BACKGROUND_MODEL (or GROQ_BACKGROUND_MODEL etc.);
 * set it to the interviewer's model to get the old single-bucket behaviour. */
const BACKGROUND_MODEL: Partial<Record<ChatBackend, string>> = {
  groq: "qwen/qwen3.6-27b",
  gemini: "gemini-2.5-flash-lite",
};

function backgroundModel(cfg: ChatConfig): string | undefined {
  const explicit = process.env[`${cfg.backend.toUpperCase()}_BACKGROUND_MODEL`]?.trim() || process.env.LLM_BACKGROUND_MODEL?.trim();
  if (explicit) return explicit === cfg.model ? undefined : explicit;
  const d = BACKGROUND_MODEL[cfg.backend];
  return d && d !== cfg.model ? d : undefined;
}

/** Background models the provider refused outright (401/403/404 — gone,
 * renamed, no access). Remembered per process so each later call goes
 * straight to the interviewer's model instead of paying a doomed round trip. */
const deadBackgroundModels = new Set<string>();

function cliSelected(): boolean {
  return cliAllowed() && process.env.LLM_PROVIDER === "claude-cli";
}

export function llmTextAvailable(): boolean {
  return chatConfig() !== null || cliSelected();
}

/** Which brain a successful llmText() call would use right now. */
export function llmSource(): LlmSource {
  const cfg = chatConfig();
  if (cfg) return cfg.backend;
  if (cliSelected()) return "claude-cli";
  return "heuristic";
}

export interface LlmTextOptions {
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  temperature?: number;
}

/** Full-text completion (no streaming). Throws when no brain is available or
 * the call fails — callers own the heuristic rescue. */
export async function llmText(prompt: string, opts: LlmTextOptions = {}): Promise<string> {
  const cfg = chatConfig();
  const timeoutMs = opts.timeoutMs ?? BACKGROUND_TIMEOUT_MS;
  if (cfg) {
    const chatOpts = {
      maxTokens: opts.maxTokens ?? 900,
      timeoutMs,
      signal: opts.signal,
      temperature: opts.temperature,
    };
    const bg = backgroundModel(cfg);
    if (bg && !deadBackgroundModels.has(bg)) {
      try {
        return await chatComplete(prompt, { ...chatOpts, model: bg }, cfg);
      } catch (err) {
        // The caller's own abort is not the model's fault — stop here.
        if (opts.signal?.aborted) throw err;
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) {
          deadBackgroundModels.add(bg);
          console.warn(`[llm] background model ${bg} is not available on this ${cfg.backend} account — using the interviewer's model for background work`);
        } else {
          // Rate-limited or broken RIGHT NOW: the interviewer's model is the
          // second bucket, exactly as before this split existed.
          console.warn(`[llm] background model ${bg} failed (${err instanceof ProviderError ? err.message : err}) — retrying on ${cfg.model}`);
        }
      }
    }
    return chatComplete(prompt, chatOpts, cfg);
  }
  if (cliSelected()) {
    // Background work: quality beats speed — sonnet.
    return runClaude(prompt, timeoutMs, "sonnet", opts.signal);
  }
  throw new Error("llm_unavailable");
}
