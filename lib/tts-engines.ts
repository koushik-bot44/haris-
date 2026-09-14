// Server-side cloud TTS engines behind one interface. Every engine returns a
// STREAMING WAV body (0xFFFFFFFF sizes, PCM16 mono) so the browser's gapless
// player treats them identically and starts playback on the first chunk:
//   elevenlabs → /stream, pcm_24000, eleven_flash_v2_5 (~75 ms model latency)
//   openai     → /audio/speech, gpt-4o-mini-tts, response_format "pcm" (24 kHz)
//   deepgram   → /v1/speak, Aura-2, linear16 24 kHz, container=none
//   groq       → /audio/speech, Orpheus, wav (≤200 chars/request → chunked)
//   gemini     → generateContent AUDIO modality, base64 PCM 24 kHz (buffered)
// Keys never leave this module. Node runtime only (route handlers).

import { castVoice, CLOUD_TTS_ENGINES, VOICE_STYLE, type CloudTtsEngine, type VoiceKey } from "@/lib/voice-cast";
import { base64ToBytes, pcmToWav, pcmToWavStream, wavHeader, type PcmFormat } from "@/lib/pcm-wav";
import { parseWavHeader } from "@/lib/wav";
import { fetchWithConnectTimeout, timeoutSignal } from "@/lib/abort";

export interface TtsAudio {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  engine: CloudTtsEngine;
}

export class TtsEngineError extends Error {
  constructor(
    public readonly engine: CloudTtsEngine,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = "TtsEngineError";
  }
}

const REQUEST_TIMEOUT_MS = 20_000;
const PCM_24K: PcmFormat = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 };

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function keyFor(engine: CloudTtsEngine): string | undefined {
  switch (engine) {
    case "elevenlabs":
      return env("ELEVENLABS_API_KEY");
    case "openai":
      return env("OPENAI_API_KEY");
    case "deepgram":
      return env("DEEPGRAM_API_KEY");
    case "groq":
      return env("GROQ_API_KEY");
    case "gemini":
      return env("GEMINI_API_KEY") ?? env("GOOGLE_API_KEY");
  }
}

/** Configured cloud engines in priority order: TTS_PROVIDER first (when its
 * key exists), then the built-in order — voice quality/latency first. */
export function cloudTtsEngines(): CloudTtsEngine[] {
  const configured = CLOUD_TTS_ENGINES.filter((e) => Boolean(keyFor(e)));
  const preferred = env("TTS_PROVIDER");
  if (preferred && (CLOUD_TTS_ENGINES as readonly string[]).includes(preferred)) {
    const p = preferred as CloudTtsEngine;
    if (configured.includes(p)) return [p, ...configured.filter((e) => e !== p)];
    console.warn(`[tts] TTS_PROVIDER=${preferred} but its API key is missing — ignoring the preference`);
  }
  return configured;
}

export function defaultCloudTtsEngine(): CloudTtsEngine | null {
  return cloudTtsEngines()[0] ?? null;
}

/** Buffered (non-streaming) calls: the whole request has a deadline. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  return timeoutSignal(REQUEST_TIMEOUT_MS, signal);
}

// ——— rate-limit hygiene ———
//
// Sentence pipelining plus pre-generated acks fire several synthesis calls
// within a second or two of each other. Free tiers meter those per minute,
// and a 429 mid-reply used to drop THAT sentence to the browser's robotic
// voice — the interviewer flipping voices mid-sentence. Two defences:
//   * a per-engine concurrency gate (no more than 2 requests in flight), and
//   * on 429, wait what the provider asks (retry-after / "try again in Xs",
//     bounded) and retry, so a sentence is delayed rather than re-voiced.

const MAX_IN_FLIGHT = 2;
const MAX_429_RETRIES = 2;
const MAX_BACKOFF_MS = 6_000;

const gates = new Map<CloudTtsEngine, { active: number; waiters: (() => void)[] }>();

async function withGate<T>(engine: CloudTtsEngine, fn: () => Promise<T>): Promise<T> {
  const g = gates.get(engine) ?? { active: 0, waiters: [] };
  gates.set(engine, g);
  if (g.active >= MAX_IN_FLIGHT) await new Promise<void>((r) => g.waiters.push(r));
  g.active++;
  try {
    return await fn();
  } finally {
    g.active--;
    g.waiters.shift()?.();
  }
}

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

async function retryDelayMs(res: Response): Promise<number> {
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return ra * 1000;
  try {
    const t = await res.clone().text();
    const m = /try again in\s*([\d.]+)\s*(ms|s)/i.exec(t);
    if (m) return m[2].toLowerCase() === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
  } catch {}
  return 0;
}

/** Run a fetch through the engine's gate, retrying a 429 after the provider's
 * own suggested delay (bounded). Anything else is returned as-is. */
async function fetchGated(engine: CloudTtsEngine, doFetch: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  return withGate(engine, async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch();
      if (res.status !== 429 || attempt >= MAX_429_RETRIES || signal?.aborted) return res;
      let wait = await retryDelayMs(res);
      if (!wait) wait = 1500 * (attempt + 1);
      if (wait > MAX_BACKOFF_MS) return res; // too long — let the client's floor voice cover it
      void res.body?.cancel().catch(() => {});
      console.warn(`[tts] ${engine} rate-limited — retrying in ${Math.round(wait)}ms`);
      await sleep(wait, signal);
    }
  });
}

/** Streaming calls: the deadline covers the connection only — a long turn is
 * never cut off mid-sentence because synthesis outlived an arbitrary timer. */
function streamFetch(engine: CloudTtsEngine, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  return fetchGated(engine, () => fetchWithConnectTimeout(url, init, REQUEST_TIMEOUT_MS, signal), signal);
}

async function failFrom(engine: CloudTtsEngine, res: Response): Promise<never> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 400);
  } catch {}
  // A rate limit is a 429 to the client too, so it can tell "wait" from "broken".
  const status = res.status === 429 ? 429 : 502;
  throw new TtsEngineError(engine, `${engine} responded ${res.status}${detail ? `: ${detail}` : ""}`, status);
}

function voiceOverrides(): Partial<Record<CloudTtsEngine, string | undefined>> {
  return {
    elevenlabs: env("ELEVENLABS_VOICE_ID"),
    openai: env("OPENAI_TTS_VOICE"),
    deepgram: env("DEEPGRAM_TTS_VOICE"),
    groq: env("GROQ_TTS_VOICE"),
    gemini: env("GEMINI_TTS_VOICE"),
  };
}

// ——— ElevenLabs ———

async function speakElevenLabs(text: string, key: VoiceKey, signal?: AbortSignal): Promise<TtsAudio> {
  const apiKey = keyFor("elevenlabs")!;
  const voiceId = castVoice("elevenlabs", key, voiceOverrides());
  const model = env("ELEVENLABS_MODEL") ?? "eleven_flash_v2_5";
  const res = await streamFetch(
    "elevenlabs",
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_24000`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/pcm" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true },
      }),
    },
    signal,
  );
  if (!res.ok || !res.body) return failFrom("elevenlabs", res);
  return { body: pcmToWavStream(res.body, PCM_24K), contentType: "audio/wav", engine: "elevenlabs" };
}

// ——— OpenAI ———

async function speakOpenAI(text: string, key: VoiceKey, signal?: AbortSignal): Promise<TtsAudio> {
  const apiKey = keyFor("openai")!;
  const base = (env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = env("OPENAI_TTS_MODEL") ?? "gpt-4o-mini-tts";
  const voice = castVoice("openai", key, voiceOverrides());
  // `instructions` is only honoured by gpt-4o-mini-tts and newer; tts-1 rejects it.
  const supportsInstructions = !/^tts-1/.test(model);
  const res = await streamFetch(
    "openai",
    `${base}/audio/speech`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        response_format: "pcm",
        ...(supportsInstructions ? { instructions: VOICE_STYLE[key] } : {}),
      }),
    },
    signal,
  );
  if (!res.ok || !res.body) return failFrom("openai", res);
  return { body: pcmToWavStream(res.body, PCM_24K), contentType: "audio/wav", engine: "openai" };
}

// ——— Deepgram Aura-2 ———

async function speakDeepgram(text: string, key: VoiceKey, signal?: AbortSignal): Promise<TtsAudio> {
  const apiKey = keyFor("deepgram")!;
  const model = castVoice("deepgram", key, voiceOverrides());
  const q = new URLSearchParams({ model, encoding: "linear16", sample_rate: "24000", container: "none" });
  const res = await streamFetch(
    "deepgram",
    `https://api.deepgram.com/v1/speak?${q.toString()}`,
    {
      method: "POST",
      headers: { authorization: `Token ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
    signal,
  );
  if (!res.ok || !res.body) return failFrom("deepgram", res);
  return { body: pcmToWavStream(res.body, PCM_24K), contentType: "audio/wav", engine: "deepgram" };
}

// ——— Groq (Orpheus) ———

/** Orpheus caps a request at ~200 characters, so a turn is synthesized as a
 * sequence of short clips. Split on sentence ends, then pack greedily. */
export function chunkForOrpheus(text: string, max = 190): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const s of sentences) {
    if (s.length > max) {
      // A single over-long sentence: break on clause/word boundaries.
      push();
      let rest = s;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(", ", max);
        if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
        if (cut <= 0) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      cur = rest;
      continue;
    }
    if ((cur + " " + s).trim().length > max) push();
    cur = cur ? `${cur} ${s}` : s;
  }
  push();
  return out;
}

async function fetchOrpheusClip(text: string, voice: string, signal?: AbortSignal): Promise<Uint8Array> {
  const apiKey = keyFor("groq")!;
  const model = env("GROQ_TTS_MODEL") ?? "canopylabs/orpheus-v1-english";
  const res = await fetchGated(
    "groq",
    () =>
      fetch("https://api.groq.com/openai/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, voice, input: text, response_format: "wav" }),
        signal: withTimeout(signal),
      }),
    signal,
  );
  if (!res.ok) return failFrom("groq", res);
  return new Uint8Array(await res.arrayBuffer());
}

/** Throw unless the bytes are a complete mono PCM16 WAV clip. */
function assertOrpheusClip(bytes: Uint8Array): void {
  let header: ReturnType<typeof parseWavHeader>;
  try {
    header = parseWavHeader(bytes);
  } catch {
    header = null;
  }
  if (!header || header.numChannels !== 1 || header.bitsPerSample !== 16) {
    throw new TtsEngineError("groq", "groq returned a clip in an unexpected format");
  }
}

/** Concatenate finite WAV clips into ONE streaming WAV: the first clip's
 * format writes the header, every clip contributes its PCM payload as soon as
 * it arrives (the next clip is fetched while the current one plays). */
function concatClipsStream(
  chunks: string[],
  fetchClip: (chunk: string) => Promise<Uint8Array>,
  engine: CloudTtsEngine,
): ReadableStream<Uint8Array> {
  let i = 0;
  let fmt: PcmFormat | null = null;
  let ahead: Promise<Uint8Array> | null = chunks.length ? fetchClip(chunks[0]) : null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (i < chunks.length) {
        const clipPromise = ahead ?? fetchClip(chunks[i]);
        i++;
        ahead = i < chunks.length ? fetchClip(chunks[i]) : null;
        // Keep a rejected look-ahead from surfacing as an unhandled rejection;
        // it is re-awaited (and thrown) on its own turn.
        ahead?.catch(() => {});
        const bytes = await clipPromise;
        const header = parseWavHeader(bytes);
        // A malformed or mismatched clip used to be SKIPPED, which silently
        // deleted a whole chunk of the interviewer's sentence — the turn played
        // on with words missing and nothing anywhere said so. Failing instead
        // lets the caller re-speak the COMPLETE text through the fallback: a
        // different voice for the whole turn beats a turn with a hole in it.
        if (!header || header.numChannels !== 1 || header.bitsPerSample !== 16) {
          throw new TtsEngineError(engine, `${engine} returned a clip in an unexpected format`);
        }
        if (!fmt) {
          fmt = { sampleRate: header.sampleRate, channels: 1, bitsPerSample: 16 };
          controller.enqueue(wavHeader(fmt, null));
        } else if (header.sampleRate !== fmt.sampleRate) {
          // Emitting this under the first clip's header would play it at the
          // wrong speed and pitch — the same voice sounding like someone else.
          throw new TtsEngineError(
            engine,
            `${engine} changed sample rate mid-utterance (${fmt.sampleRate} → ${header.sampleRate})`,
          );
        }
        controller.enqueue(bytes.subarray(header.dataOffset));
        return;
      }
      if (!fmt) throw new TtsEngineError(engine, `${engine} produced no audio`);
      controller.close();
    },
  });
}

async function speakGroq(text: string, key: VoiceKey, signal?: AbortSignal): Promise<TtsAudio> {
  const voice = castVoice("groq", key, voiceOverrides());
  const chunks = chunkForOrpheus(text);
  if (chunks.length === 0) throw new TtsEngineError("groq", "empty text", 400);
  // Validate the first clip eagerly so a bad key/model surfaces as a proper
  // HTTP error instead of a broken stream.
  const first = await fetchOrpheusClip(chunks[0], voice, signal);
  // Validate its FORMAT eagerly too. concatClipsStream would refuse it on the
  // first pull, but by then the route has already sent 200 + audio headers,
  // so the client sees a stream that dies before any audio and retries the
  // whole utterance buffered — a second /api/tts call AND a second Orpheus
  // request for a clip that was never going to play. Out of a 100/day budget.
  assertOrpheusClip(first);
  let served = false;
  const body = concatClipsStream(
    chunks,
    async (chunk) => {
      if (!served && chunk === chunks[0]) {
        served = true;
        return first;
      }
      return fetchOrpheusClip(chunk, voice, signal);
    },
    "groq",
  );
  return { body, contentType: "audio/wav", engine: "groq" };
}

// ——— Gemini ———

async function speakGemini(text: string, key: VoiceKey, signal?: AbortSignal): Promise<TtsAudio> {
  const apiKey = keyFor("gemini")!;
  const model = env("GEMINI_TTS_MODEL") ?? "gemini-2.5-flash-preview-tts";
  const voiceName = castVoice("gemini", key, voiceOverrides());
  const res = await fetchGated(
    "gemini",
    () =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        }),
        signal: withTimeout(signal),
      }),
    signal,
  );
  if (!res.ok) return failFrom("gemini", res);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
  };
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  const inline = part?.inlineData;
  if (!inline?.data) throw new TtsEngineError("gemini", "gemini returned no audio");
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1] ?? 24_000);
  const pcm = base64ToBytes(inline.data);
  // Already a WAV? (some model versions wrap it) — pass through untouched.
  const isWav = pcm.length > 12 && pcm[0] === 0x52 && pcm[1] === 0x49 && pcm[2] === 0x46 && pcm[3] === 0x46;
  const wav = isWav ? pcm : pcmToWav(pcm, { sampleRate: rate, channels: 1, bitsPerSample: 16 });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(wav);
      controller.close();
    },
  });
  return { body, contentType: "audio/wav", engine: "gemini" };
}

// ——— dispatch ———

export async function cloudSpeak(
  engine: CloudTtsEngine,
  text: string,
  key: VoiceKey,
  signal?: AbortSignal,
): Promise<TtsAudio> {
  if (!keyFor(engine)) throw new TtsEngineError(engine, `${engine} is not configured`, 404);
  switch (engine) {
    case "elevenlabs":
      return speakElevenLabs(text, key, signal);
    case "openai":
      return speakOpenAI(text, key, signal);
    case "deepgram":
      return speakDeepgram(text, key, signal);
    case "groq":
      return speakGroq(text, key, signal);
    case "gemini":
      return speakGemini(text, key, signal);
  }
}
