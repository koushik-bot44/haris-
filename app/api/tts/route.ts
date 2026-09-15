import { NextResponse } from "next/server";
import { z } from "zod";
import { WAV_VOICE_RE } from "@/lib/voices";
import { isVoiceKey, voiceKeyOf, CLOUD_TTS_ENGINES } from "@/lib/voice-cast";
import {
  CHATTERBOX_DEFAULT_CHUNK,
  CHATTERBOX_DEFAULT_TUNING,
  CHATTERBOX_SEED_BASE,
  chatterboxRequestBody,
  chatterboxSeed,
  chatterboxVoiceFile,
  type ChatterboxTuning,
} from "@/lib/chatterbox-request";
import { cloudSpeak, cloudTtsEngines, defaultCloudTtsEngine, TtsEngineError } from "@/lib/tts-engines";
import { pcmToWav } from "@/lib/pcm-wav";
import { parseWavHeader } from "@/lib/wav";
import { stripSpeechTags } from "@/lib/speakable";
import { CACHEABLE_TEXT_MAX, ttsCacheGet, ttsCacheKey, ttsCacheSet } from "@/lib/tts-cache";

/** Collapse a streaming WAV (unbounded sizes) into a finite one that
 * decodeAudioData accepts — for callers that pre-fetch and decode whole
 * utterances (speculative turns, cached acks). */
async function finiteWav(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await new Response(stream).arrayBuffer());
  try {
    const header = parseWavHeader(bytes);
    if (!header) return bytes;
    return pcmToWav(bytes.subarray(header.dataOffset), {
      sampleRate: header.sampleRate,
      channels: header.numChannels,
      bitsPerSample: header.bitsPerSample,
    });
  } catch {
    return bytes;
  }
}

// The voice endpoint. One request shape for every engine:
//   engine "cloud"      → the best configured cloud voice (TTS_PROVIDER or the
//                         first key found) — what the browser normally asks for
//   engine <cloud name> → that specific cloud engine (404 when not configured)
//   engine "chatterbox" → the LOCAL Chatterbox-TTS-Server (studio voice/cloning)
// Every cloud response is a STREAMING WAV (PCM16 mono) so playback starts on
// the first chunk. Keys stay server-side. GET reports what is available, with
// no secrets, so the client can pick an engine before the interview starts.

/** Streaming synthesis must outlive the platform's default function timeout. */
export const maxDuration = 60;

const bodySchema = z.object({
  text: z.string().min(1).max(2000),
  engine: z.enum(["cloud", ...CLOUD_TTS_ENGINES, "chatterbox", "elevenlabs"]).default("cloud"),
  // A persona key ("hr", "moderator", …) or a legacy wav filename. The regex
  // admits no path separators; ".." is refused outright so the name can never
  // walk the Chatterbox voices dir.
  voice: z
    .string()
    .max(64)
    .refine((v) => isVoiceKey(v) || (WAV_VOICE_RE.test(v) && !v.includes("..")), "unknown voice")
    .optional(),
  stream: z.boolean().default(true),
});

function chatterboxUrl(): string | null {
  const u = process.env.CHATTERBOX_URL?.trim();
  if (u) return u.replace(/\/+$/, "");
  // Unset in production means "no local voice server" — never probe localhost
  // on a deployed host. Locally the documented default port still works.
  return process.env.NODE_ENV === "production" ? null : "http://127.0.0.1:8004";
}

// The landing page polls GET while idle — probe at most once per 5s.
const PROBE_TTL_MS = 5_000;
let probeCache: { at: number; chatterbox: boolean; voices: string[] } | null = null;

async function probeChatterbox(): Promise<{ chatterbox: boolean; voices: string[] }> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache;
  let chatterbox = false;
  let voices: string[] = [];
  const base = chatterboxUrl();
  if (base) {
    try {
      const res = await fetch(`${base}/v1/audio/voices`, { signal: AbortSignal.timeout(800), cache: "no-store" });
      if (res.ok) {
        chatterbox = true;
        const d: unknown = await res.json();
        const list = (d as { voices?: unknown })?.voices;
        voices = Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
      }
    } catch {
      // server down — chatterbox stays false, voices stays []
    }
  }
  probeCache = { at: Date.now(), chatterbox, voices };
  return probeCache;
}

export async function GET() {
  const { chatterbox, voices } = await probeChatterbox();
  const engines = cloudTtsEngines();
  return NextResponse.json(
    {
      /** The engine `engine:"cloud"` resolves to right now, or null. */
      cloud: engines[0] ?? null,
      /** Every configured cloud engine, best first. */
      engines,
      chatterbox,
      voices,
      /** The interviewer-voice override this server applies, so a browser that
       * reaches a Chatterbox server of its own renders the same speaker. */
      chatterboxVoice: process.env.CHATTERBOX_VOICE?.trim() || null,
      // legacy fields (older clients)
      enabled: engines.includes("elevenlabs"),
      elevenlabs: engines.includes("elevenlabs"),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

const AUDIO_HEADERS = (engine: string) => ({
  "content-type": "audio/wav",
  "cache-control": "no-store",
  "x-tts-engine": engine,
});

/** Numeric env override, or the default when unset/blank/garbage.
 *
 * The blank case matters and is easy to get wrong: Number("") is 0 and
 * Number.isFinite(0) is true, so an empty or whitespace-only value used to read
 * as a deliberate zero. `.env.example` ships these as commented lines, so
 * uncommenting one without typing a value is the natural mistake — and
 * CHATTERBOX_SEED=0 means "re-roll the voice on every request" to that server,
 * i.e. exactly the drifting interviewer the per-persona seed exists to stop. */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Generation knobs for the Chatterbox request — the shared shape in
 * lib/chatterbox-request.ts (also what the browser sends when it talks to the
 * candidate's own server directly), with this server's env overrides.
 * CHATTERBOX_SEED replaces the seed base (0 restores the server's random
 * behaviour); the rest replace the documented defaults. */
function chatterboxTuning(key: string): ChatterboxTuning {
  return {
    seed: chatterboxSeed(key, envNum("CHATTERBOX_SEED", CHATTERBOX_SEED_BASE)),
    temperature: envNum("CHATTERBOX_TEMPERATURE", CHATTERBOX_DEFAULT_TUNING.temperature),
    exaggeration: envNum("CHATTERBOX_EXAGGERATION", CHATTERBOX_DEFAULT_TUNING.exaggeration),
    cfg_weight: envNum("CHATTERBOX_CFG_WEIGHT", CHATTERBOX_DEFAULT_TUNING.cfg_weight),
    speed_factor: envNum("CHATTERBOX_SPEED", CHATTERBOX_DEFAULT_TUNING.speed_factor),
  };
}

async function speakChatterbox(text: string, voice: string | undefined, stream: boolean, signal: AbortSignal) {
  const base = chatterboxUrl();
  if (!base) return NextResponse.json({ error: "chatterbox_disabled" }, { status: 404 });
  const key = voiceKeyOf(voice);
  // CHATTERBOX_VOICE overrides the two 1:1 interviewer personas only, matching
  // castVoice()'s rule for the cloud engines — the four GD debaters keep their
  // distinct cast or the room loses track of who is speaking. It used to be
  // written as `chatterboxVoiceFor(key) || process.env.CHATTERBOX_VOICE`, but
  // chatterboxVoiceFor always returns a filename, so the env var was documented
  // configuration that could never take effect: pointing it at a cloned voice
  // silently kept Emily.wav.
  const voiceFile = chatterboxVoiceFile(voice, process.env.CHATTERBOX_VOICE);
  // The budget covers the wait for the server to START answering — the first
  // rendered chunk when streaming, the whole file when not. The body is NOT
  // under this timer: a streamed line is read as it renders (a 14 s greeting
  // took 21 s to render on a loaded laptop), and a fixed cut on the stream
  // truncated the line mid-sentence and reported a 502 that latched the
  // session onto the on-device voice. The client's own disconnect (`signal`)
  // still stops everything, and maxDuration bounds the whole request.
  const ctl = new AbortController();
  if (signal.aborted) ctl.abort(signal.reason);
  else signal.addEventListener("abort", () => ctl.abort(signal.reason), { once: true });
  const headersTimer = setTimeout(() => ctl.abort(new DOMException("chatterbox did not start answering", "TimeoutError")), stream ? 20_000 : 45_000);
  // Native /tts for both draws. Streamed, it answers a chunked WAV (0xFFFFFFFF
  // sizes) flushed as each text chunk finishes; non-streamed, the SAME endpoint
  // answers a finite WAV. (The OpenAI-compatible /v1/audio/speech used to carry
  // draw 2: it accepts only `speed` and `seed` and fills the other knobs from
  // the server's own config, so the opening sentence was sampled at 0.7 and the
  // remainder at 0.8 — two renderings of one speaker inside one turn.) Chunk
  // size IS the time-to-first-audio: Chatterbox renders a whole chunk in one
  // forward pass, 50 is the documented minimum, and the 20 ms crossfade makes
  // small chunks free.
  let res: Response;
  try {
    res = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatterboxRequestBody(text, voiceFile, stream, chatterboxTuning(key), envNum("CHATTERBOX_CHUNK_SIZE", CHATTERBOX_DEFAULT_CHUNK))),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(headersTimer);
  }
  // `!res.body` matters as much as `!res.ok`: a 200 with an empty body would
  // otherwise be forwarded as a 0-byte audio/wav, and the buffered path is what
  // callers use to pre-fetch and decode a whole utterance — decodeAudioData
  // throws on it instead of taking the clean 502 and letting the fallback voice
  // speak.
  if (!res.ok || !res.body) return NextResponse.json({ error: "chatterbox_error", status: res.status }, { status: 502 });
  return new NextResponse(res.body, { headers: AUDIO_HEADERS("chatterbox") });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid shape" }, { status: 400 });
  const { text, engine, voice, stream } = parsed.data;

  if (engine === "chatterbox") {
    try {
      return await speakChatterbox(text, voice, stream, req.signal);
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return NextResponse.json({ error: aborted ? "chatterbox_timeout" : "chatterbox_unreachable" }, { status: 502 });
    }
  }

  const target = engine === "cloud" ? defaultCloudTtsEngine() : engine;
  if (!target) {
    return NextResponse.json(
      { error: "no_cloud_tts", message: "No cloud voice is configured on this server." },
      { status: 404 },
    );
  }
  try {
    // Chatterbox-Turbo's [chuckle]/[sigh] tags mean nothing to cloud voices —
    // they would be read aloud as words.
    const spoken = stripSpeechTags(text) || text;
    const key = voiceKeyOf(voice);
    // Short lines (acks, nudges, short questions) repeat across sessions —
    // serve them from memory and spend the rate-limit budget on real turns.
    const cacheable = spoken.length <= CACHEABLE_TEXT_MAX;
    const cacheKey = ttsCacheKey(target, key, spoken);
    if (cacheable) {
      const hit = ttsCacheGet(cacheKey);
      if (hit) {
        return new NextResponse(new Blob([hit], { type: "audio/wav" }), {
          headers: { ...AUDIO_HEADERS(target), "x-tts-cache": "hit" },
        });
      }
    }
    const audio = await cloudSpeak(target, spoken, key, req.signal);
    if (!stream) {
      // A finite WAV: what decodeAudioData wants, and what the streaming
      // player also accepts (it only needs a parsable header).
      const wav = await finiteWav(audio.body);
      if (cacheable) ttsCacheSet(cacheKey, wav);
      return new NextResponse(new Blob([wav], { type: "audio/wav" }), {
        headers: { ...AUDIO_HEADERS(audio.engine), "x-tts-cache": "miss" },
      });
    }
    if (cacheable) {
      // Stream to the browser AND fill the cache from the same bytes. Buffering
      // the whole clip first (what this used to do for anything under
      // CACHEABLE_TEXT_MAX) delayed the first syllable of every SHORT line —
      // which is precisely the opening sentence of every turn, the one the
      // whole streaming path exists to make fast.
      const [toClient, toCache] = audio.body.tee();
      void finiteWav(toCache)
        .then((wav) => ttsCacheSet(cacheKey, wav))
        .catch(() => {});
      return new NextResponse(toClient, { headers: { ...AUDIO_HEADERS(audio.engine), "x-tts-cache": "miss" } });
    }
    return new NextResponse(audio.body, { headers: AUDIO_HEADERS(audio.engine) });
  } catch (err) {
    if (err instanceof TtsEngineError) {
      console.warn(`[tts] ${err.engine} failed: ${err.message}`);
      return NextResponse.json({ error: "tts_error", engine: err.engine, message: err.message }, { status: err.status });
    }
    const aborted = err instanceof Error && err.name === "AbortError";
    if (!aborted) console.warn(`[tts] ${target} failed:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: aborted ? "tts_timeout" : "tts_error", engine: target }, { status: 502 });
  }
}
