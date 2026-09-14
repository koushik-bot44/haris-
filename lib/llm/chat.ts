// One chat-completions transport for every cloud LLM. Groq, OpenAI, Gemini
// (its OpenAI-compatible endpoint), OpenRouter and any self-hosted server all
// speak the same wire protocol — POST /chat/completions, optional SSE stream —
// so the interviewer, the scorer, the resume coach, the guidance counselor and
// the GD debate all ride this ONE function and differ only in config.
//
// Selection (server-side, never exposed to the browser):
//   LLM_PROVIDER=groq|openai|gemini|openrouter|custom  → that backend, or
//   unset → the first backend whose key exists, in the order below (Groq
//   first: it is the fastest, which is what a voice conversation needs).
//
// Failure kinds are explicit (rate_limited / unavailable / malformed) so the
// callers' rescue paths can log WHY the fixture bank took over.

import { ProviderError } from "@/lib/llm/provider";
import { timeoutSignal } from "@/lib/abort";

export type ChatBackend = "groq" | "openai" | "gemini" | "openrouter" | "custom";

export interface ChatConfig {
  backend: ChatBackend;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Tried once when the main model is rate-limited (429). */
  fallbackModel: string | null;
  /** Extra headers some gateways want (OpenRouter attribution). */
  headers: Record<string, string>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Raw text deltas as they arrive. Presence switches the request to SSE. */
  onDelta?: (delta: string) => void;
}

const DEFAULT_TIMEOUT_MS = 12_000;

const BACKEND_ORDER: ChatBackend[] = ["groq", "openai", "gemini", "openrouter", "custom"];

// Model defaults, all overridable: the provider-specific *_MODEL wins, then the
// generic LLM_MODEL, then these. Pinned to ids verified live on 2026-08-24;
// swap via env, never via code. Model rosters ROTATE (a fresh Groq account
// no longer sees any llama-3.x model at all), so an unavailable model is
// healed at runtime from the provider's /models list — see healModel().
const DEFAULTS: Record<ChatBackend, { baseUrl: string; model: string; fallback: string | null }> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    fallback: "openai/gpt-oss-20b",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    // gpt-4o-mini is no longer on OpenAI's model page (checked 2026-08-24);
    // gpt-5.6-luna is the current cost-sensitive tier. Override: OPENAI_MODEL.
    model: "gpt-5.6-luna",
    fallback: null,
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    fallback: "gemini-2.5-flash-lite",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct",
    fallback: null,
  },
  custom: {
    baseUrl: "",
    model: "",
    fallback: null,
  },
};

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function keyFor(backend: ChatBackend): string | undefined {
  switch (backend) {
    case "groq":
      return env("GROQ_API_KEY");
    case "openai":
      return env("OPENAI_API_KEY");
    case "gemini":
      return env("GEMINI_API_KEY") ?? env("GOOGLE_API_KEY");
    case "openrouter":
      return env("OPENROUTER_API_KEY");
    case "custom":
      return env("LLM_API_KEY");
  }
}

function modelEnvFor(backend: ChatBackend): string | undefined {
  switch (backend) {
    case "groq":
      return env("GROQ_MODEL");
    case "openai":
      return env("OPENAI_MODEL");
    case "gemini":
      return env("GEMINI_MODEL");
    case "openrouter":
      return env("OPENROUTER_MODEL");
    case "custom":
      return env("LLM_MODEL");
  }
}

function fallbackEnvFor(backend: ChatBackend): string | undefined {
  switch (backend) {
    case "groq":
      return env("GROQ_FALLBACK_MODEL");
    case "gemini":
      return env("GEMINI_FALLBACK_MODEL");
    default:
      return env("LLM_FALLBACK_MODEL");
  }
}

/** Models the provider told us we cannot use, mapped to what we use instead
 * (process lifetime). Keyed by backend + base URL. */
const modelOverrides = new Map<string, string>();

/** Preferred replacements, best first, when the configured model is gone. */
const MODEL_PREFERENCE: Record<ChatBackend, string[]> = {
  groq: [
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
    "qwen/qwen3.6-27b",
    "llama-3.1-70b-versatile",
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant",
    "groq/compound-mini",
  ],
  openai: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"],
  gemini: ["gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-3.7-flash"],
  openrouter: ["meta-llama/llama-3.3-70b-instruct", "openai/gpt-oss-120b", "google/gemini-2.5-flash"],
  custom: [],
};

/** Ids on a /models list that are not chat models. */
const NOT_A_CHAT_MODEL = /whisper|tts|orpheus|playai|guard|embed|moderation|safeguard|allam|rerank|image|vision-preview|audio/i;

/** Reasoning-class models spend completion tokens thinking before they answer;
 * callers give them more room and we ask for the cheapest effort. */
export function isReasoningModel(model: string): boolean {
  return /gpt-oss|gpt-5|qwen3|deepseek-r1|\bo[1-4](?:-|$)|reasoning|thinking/i.test(model);
}

function reasoningParams(cfg: ChatConfig, model: string): Record<string, unknown> {
  if (!isReasoningModel(model)) return {};
  if (cfg.backend === "groq") {
    // Groq: keep the thinking short and out of the reply text.
    if (/gpt-oss/i.test(model)) return { reasoning_effort: "low", reasoning_format: "hidden" };
    // Qwen3 on Groq accepts only `none` | `default` for reasoning_effort, and
    // `default` is expensive: measured on qwen3.6-27b, a 900-token budget was
    // spent ENTIRELY on <think> (finish_reason "length", empty content) in
    // ~1.9 s — every background score, guidance and GD batch parsed as junk and
    // fell to the heuristics. With "none" the same prompt returned clean JSON
    // in 129 ms using 21 completion tokens. `reasoning_format: "hidden"` alone
    // only hides the thinking; the tokens are still burned.
    if (/qwen/i.test(model)) return { reasoning_effort: "none" };
    return { reasoning_format: "hidden" };
  }
  if (cfg.backend === "openai") return { reasoning_effort: "low" };
  return {};
}

/** A replacement applies only while the model it replaced is the configured
 * one — change the env and the override is naturally out of the way. */
function overrideKey(cfg: Pick<ChatConfig, "backend" | "baseUrl">, failedModel: string): string {
  return `${cfg.backend}|${cfg.baseUrl}|${failedModel}`;
}

function configFor(backend: ChatBackend): ChatConfig | null {
  const apiKey = keyFor(backend);
  if (!apiKey) return null;
  const d = DEFAULTS[backend];
  const baseUrl = ((backend === "custom" ? env("LLM_BASE_URL") : env(`${backend.toUpperCase()}_BASE_URL`)) ?? d.baseUrl).replace(/\/+$/, "");
  const configured = modelEnvFor(backend) ?? env("LLM_MODEL") ?? d.model;
  if (!baseUrl || !configured) return null;
  const model = modelOverrides.get(overrideKey({ backend, baseUrl }, configured)) ?? configured;
  const headers: Record<string, string> = {};
  if (backend === "openrouter") {
    headers["HTTP-Referer"] = env("APP_URL") ?? "https://placement-day-simulator.local";
    headers["X-Title"] = "Placement Day Simulator";
  }
  return {
    backend,
    baseUrl,
    apiKey,
    model,
    fallbackModel: fallbackEnvFor(backend) ?? d.fallback,
    headers,
  };
}

// ——— model healing ———

const modelListCache = new Map<string, { at: number; ids: Set<string> }>();
const MODEL_LIST_TTL_MS = 10 * 60_000;

/** The provider's current model roster (OpenAI-compatible GET /models). */
async function listModels(cfg: ChatConfig): Promise<Set<string> | null> {
  const cached = modelListCache.get(cfg.baseUrl);
  if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) return cached.ids;
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}`, ...cfg.headers },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { data?: { id?: string; active?: boolean }[] };
    const ids = new Set((d.data ?? []).filter((m) => m.id && m.active !== false).map((m) => m.id as string));
    modelListCache.set(cfg.baseUrl, { at: Date.now(), ids });
    return ids;
  } catch {
    return null;
  }
}

/** Did the provider say THIS MODEL is not usable (gone, renamed, no access)? */
function isModelMissing(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  const status = (err as ProviderError & { status?: number }).status;
  if (status === 404) return true;
  return status === 400 && /model/i.test(err.message) && /(not exist|not found|unknown|invalid|decommission|no access|does not have access|deprecated)/i.test(err.message);
}

/** Pick a model the account can actually use and remember it. Returns the
 * replacement, or null when nothing on the roster is usable. */
export async function healModel(cfg: ChatConfig, failedModel: string): Promise<string | null> {
  const ids = await listModels(cfg);
  if (!ids || ids.size === 0) return null;
  // Quality first (the roster is ordered best → smallest), the designated
  // rate-limit fallback last, then anything chat-shaped the account has.
  const candidates = [...MODEL_PREFERENCE[cfg.backend], cfg.fallbackModel].filter((m): m is string => Boolean(m));
  let pick = candidates.find((m) => m !== failedModel && ids.has(m));
  if (!pick) pick = [...ids].find((id) => id !== failedModel && !NOT_A_CHAT_MODEL.test(id));
  if (!pick) return null;
  modelOverrides.set(overrideKey(cfg, failedModel), pick);
  console.warn(
    `[llm] ${cfg.backend} model "${failedModel}" is not available on this account — using "${pick}" instead. ` +
      `Set ${cfg.backend === "custom" ? "LLM_MODEL" : `${cfg.backend.toUpperCase()}_MODEL`} to make this explicit.`,
  );
  return pick;
}

/** The backend the deployment will use, or null when only the mock/CLI
 * brains are available. Explicit LLM_PROVIDER beats auto-detection; an
 * explicit choice without its key is a configuration error we surface. */
export function chatConfig(): ChatConfig | null {
  const explicit = env("LLM_PROVIDER");
  if (explicit) {
    if ((BACKEND_ORDER as string[]).includes(explicit)) {
      const cfg = configFor(explicit as ChatBackend);
      if (!cfg) {
        warnOnce(
          `explicit-${explicit}`,
          `[llm] LLM_PROVIDER=${explicit} but its API key is missing — falling back to the scripted interviewer`,
        );
      }
      return cfg;
    }
    // mock / claude-cli / unknown → not a cloud backend.
    return null;
  }
  for (const b of BACKEND_ORDER) {
    const cfg = configFor(b);
    if (cfg) return cfg;
  }
  return null;
}

export function chatEnabled(): boolean {
  return chatConfig() !== null;
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

/** Models the org turned out not to have access to (401/403/404 on the
 * fallback) — remembered per process so a doomed retry is never repeated. */
const deadFallbacks = new Set<string>();

function statusKind(status: number): ProviderError["kind"] {
  if (status === 429) return "rate_limited";
  return "unavailable";
}

/** How long the provider asked us to wait, in ms, or 0 when it did not say.
 * Groq puts it in both places: a `retry-after` header (whole seconds) and the
 * body ("Please try again in 615.4ms"). The body is finer-grained. */
function retryAfterMs(res: Response, detail: string): number {
  const m = /try again in\s*([\d.]+)\s*(ms|s)\b/i.exec(detail);
  if (m) return m[2].toLowerCase() === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
  const ra = Number(res.headers.get("retry-after"));
  return Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0;
}

/** The longest we will hold a turn for the MAIN model before switching to the
 * fallback model. Groq's per-minute token bucket refills continuously, so its
 * 429s usually ask for well under a second — a wait that short keeps the
 * conversation on the better model; beyond this a candidate hears dead air. */
const RATE_LIMIT_WAIT_MAX_MS = 2_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

async function request(cfg: ChatConfig, messages: ChatMessage[], model: string, opts: ChatOptions): Promise<string> {
  const signal = timeoutSignal(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
  const stream = Boolean(opts.onDelta);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
        ...cfg.headers,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 400,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...reasoningParams(cfg, model),
        stream,
      }),
      signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new ProviderError(
      aborted ? `${cfg.backend} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : `${cfg.backend} network error`,
      "unavailable",
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string } | string };
      detail = typeof j.error === "string" ? j.error : (j.error?.message ?? "");
    } catch {}
    const e = new ProviderError(`${cfg.backend}_${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`, statusKind(res.status));
    (e as ProviderError & { status?: number }).status = res.status;
    if (res.status === 429) (e as ProviderError & { retryAfterMs?: number }).retryAfterMs = retryAfterMs(res, detail);
    throw e;
  }
  if (!stream || !res.body) {
    const d = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return d.choices?.[0]?.message?.content ?? "";
  }
  // OpenAI-style SSE: `data: {json}` lines, terminated by `data: [DONE]`.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : null;
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          opts.onDelta?.(delta);
        }
      } catch {
        // partial/noise line — ignore
      }
    }
    if (done) break;
  }
  return full;
}

/** Chat completion against the configured backend. Streams when onDelta is
 * given; resolves to the full text either way. A 429 on the main model is
 * retried ONCE on the fallback model (a smaller model still holds a real
 * conversation; the fixture bank does not). Throws ProviderError. */
export async function chatComplete(
  input: string | ChatMessage[],
  opts: ChatOptions = {},
  cfgOverride?: ChatConfig | null,
): Promise<string> {
  const cfg = cfgOverride ?? chatConfig();
  if (!cfg) throw new ProviderError("no cloud LLM configured", "unavailable");
  const messages: ChatMessage[] = typeof input === "string" ? [{ role: "user", content: input }] : input;
  const model = opts.model ?? cfg.model;
  try {
    return await request(cfg, messages, model, opts);
  } catch (err) {
    // The configured model is gone / renamed / not on this account: find one
    // that exists and retry once. This is the difference between "the AI
    // silently became a question bank" and a conversation that just works.
    if (isModelMissing(err)) {
      const healed = await healModel(cfg, model);
      if (healed) return request(cfg, messages, healed, opts);
      throw err;
    }
    const pe = err instanceof ProviderError ? err : null;
    if (!pe || pe.kind !== "rate_limited") throw err;
    // A SHORT rate-limit wait is worth paying to stay on the main model. Every
    // Groq model has its own tokens-per-minute bucket that refills continuously
    // (measured: an interview turn costs ~2,000-2,700 of 8,000), so the 429 it
    // returns typically says "try again in 600ms". Switching models on that
    // instantly — what this used to do — meant the candidate got the smaller
    // model for a turn, then the bigger one, then the smaller one again: the
    // interviewer's judgement changing character mid-round for want of half a
    // second. Wait once, bounded, then retry the same model; only a longer ask
    // (or a second 429) goes to the fallback.
    const wait = (pe as ProviderError & { retryAfterMs?: number }).retryAfterMs ?? 0;
    if (wait > 0 && wait <= RATE_LIMIT_WAIT_MAX_MS && !opts.signal?.aborted) {
      console.warn(`[llm] ${cfg.backend} ${model} rate-limited — waiting ${Math.round(wait)}ms and retrying the same model`);
      await sleep(wait, opts.signal);
      try {
        return await request(cfg, messages, model, opts);
      } catch (again) {
        const pe2 = again instanceof ProviderError ? again : null;
        if (!pe2 || pe2.kind !== "rate_limited") throw again;
        // still limited — fall through to the fallback model below
      }
    }
    const fb = cfg.fallbackModel;
    if (!fb || fb === model || deadFallbacks.has(fb)) throw err;
    console.warn(`[llm] ${cfg.backend} main model rate-limited, retrying on ${fb}`);
    try {
      return await request(cfg, messages, fb, opts);
    } catch (fbErr) {
      const status = (fbErr as { status?: number }).status;
      if (status === 401 || status === 403 || status === 404) {
        deadFallbacks.add(fb);
        console.warn(`[llm] fallback model ${fb} is not available on this ${cfg.backend} account — will not retry it again`);
      }
      throw fbErr;
    }
  }
}

/** Human label for the UI/health endpoint: "groq/llama-3.3-70b-versatile". */
export function chatLabel(): string | null {
  const cfg = chatConfig();
  return cfg ? `${cfg.backend}/${cfg.model}` : null;
}
