// Server-side speech-to-text providers behind one function. The browser
// posts a short WAV utterance to /api/stt; this forwards it to whichever
// transcription API has a key:
//   groq     → whisper-large-v3-turbo (fast, free tier: 2000 requests/day)
//   openai   → gpt-4o-mini-transcribe
//   deepgram → nova-3 pre-recorded
// Deepgram additionally offers LIVE streaming; the browser gets a temporary
// token from /api/stt/token for that (never the key).

import { timeoutSignal } from "@/lib/abort";

export type SttProvider = "groq" | "openai" | "deepgram";
const ORDER: SttProvider[] = ["groq", "openai", "deepgram"];

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function keyFor(p: SttProvider): string | undefined {
  switch (p) {
    case "groq":
      return env("GROQ_API_KEY");
    case "openai":
      return env("OPENAI_API_KEY");
    case "deepgram":
      return env("DEEPGRAM_API_KEY");
  }
}

/** The provider /api/stt will use, honouring STT_PROVIDER when its key exists. */
export function sttProvider(): SttProvider | null {
  const preferred = env("STT_PROVIDER");
  if (preferred && (ORDER as string[]).includes(preferred) && keyFor(preferred as SttProvider)) {
    return preferred as SttProvider;
  }
  return ORDER.find((p) => Boolean(keyFor(p))) ?? null;
}

export function deepgramLiveEnabled(): boolean {
  return Boolean(env("DEEPGRAM_API_KEY")) && env("DEEPGRAM_LIVE") !== "0";
}

const TIMEOUT_MS = 20_000;

export interface TranscribeOptions {
  language?: string;
  signal?: AbortSignal;
  /** Words the model should expect (names, jargon) — improves spelling. */
  prompt?: string;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  return timeoutSignal(TIMEOUT_MS, signal);
}

async function transcribeOpenAiStyle(
  provider: "groq" | "openai",
  audio: Blob,
  filename: string,
  opts: TranscribeOptions,
): Promise<string> {
  const apiKey = keyFor(provider)!;
  const base =
    provider === "groq"
      ? "https://api.groq.com/openai/v1"
      : (env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model =
    provider === "groq" ? (env("GROQ_STT_MODEL") ?? "whisper-large-v3-turbo") : (env("OPENAI_STT_MODEL") ?? "gpt-4o-mini-transcribe");
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (opts.language) form.append("language", opts.language);
  if (opts.prompt) form.append("prompt", opts.prompt.slice(0, 500));
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: withTimeout(opts.signal),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {}
    throw new Error(`${provider}_${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const d = (await res.json()) as { text?: string };
  return typeof d.text === "string" ? d.text : "";
}

async function transcribeDeepgram(audio: Blob, opts: TranscribeOptions): Promise<string> {
  const apiKey = keyFor("deepgram")!;
  const q = new URLSearchParams({ model: "nova-3", smart_format: "true", language: opts.language ?? "en" });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${q.toString()}`, {
    method: "POST",
    headers: { authorization: `Token ${apiKey}`, "content-type": audio.type || "audio/wav" },
    body: audio,
    signal: withTimeout(opts.signal),
  });
  if (!res.ok) throw new Error(`deepgram_${res.status}`);
  const d = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
  return d.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

export async function transcribeAudio(
  audio: Blob,
  filename: string,
  opts: TranscribeOptions = {},
): Promise<{ text: string; provider: SttProvider }> {
  const provider = sttProvider();
  if (!provider) throw new Error("stt_disabled");
  const text =
    provider === "deepgram"
      ? await transcribeDeepgram(audio, opts)
      : await transcribeOpenAiStyle(provider, audio, filename, opts);
  return { text: text.trim(), provider };
}

/** Mint a short-lived Deepgram JWT for the browser's live socket. */
export async function mintDeepgramToken(ttlSeconds = 60): Promise<{ token: string; expiresIn: number }> {
  const apiKey = env("DEEPGRAM_API_KEY");
  if (!apiKey) throw new Error("deepgram_disabled");
  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { authorization: `Token ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`deepgram_grant_${res.status}`);
  const d = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error("deepgram_grant_empty");
  return { token: d.access_token, expiresIn: d.expires_in ?? ttlSeconds };
}
