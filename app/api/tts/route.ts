import { NextResponse } from "next/server";
import { z } from "zod";
import { WAV_VOICE_RE } from "@/lib/voices";

// Server-voice proxy for two engines:
// - chatterbox: the LOCAL Chatterbox-TTS-Server (localhost:8004, MPS) —
//   studio-grade voice + zero-shot cloning, fully offline, no keys. With
//   stream:true the native /tts endpoint flushes WAV bytes per synthesized
//   chunk, so the client starts playback before synthesis finishes.
// - elevenlabs: cloud, active only when ELEVENLABS_API_KEY exists (free
//   signup tier). Key stays server-side.
// Kokoro remains the in-browser premium path; system voice the instant floor.

const bodySchema = z.object({
  text: z.string().min(1).max(2000),
  engine: z.enum(["elevenlabs", "chatterbox"]).default("elevenlabs"),
  // Wav filename only — the regex admits no path separators; ".." is refused
  // outright so the name can never walk the voices dir.
  voice: z
    .string()
    .regex(WAV_VOICE_RE)
    .refine((v) => !v.includes(".."))
    .optional(),
  stream: z.boolean().default(false),
});

const DEFAULT_ELEVEN_VOICE = "21m00Tcgm4TlvDq8ikWAM"; // Rachel — warm, professional

function chatterboxUrl(): string {
  return process.env.CHATTERBOX_URL ?? "http://127.0.0.1:8004";
}

// The landing page polls GET while idle — probe at most once per 5s.
const PROBE_TTL_MS = 5_000;
let probeCache: { at: number; chatterbox: boolean; voices: string[] } | null = null;

async function probeChatterbox(): Promise<{ chatterbox: boolean; voices: string[] }> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache;
  let chatterbox = false;
  let voices: string[] = [];
  try {
    const res = await fetch(`${chatterboxUrl()}/v1/audio/voices`, {
      signal: AbortSignal.timeout(800),
      cache: "no-store",
    });
    if (res.ok) {
      chatterbox = true;
      const d: unknown = await res.json();
      const list = (d as { voices?: unknown })?.voices;
      voices = Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
    }
  } catch {
    // server down — chatterbox stays false, voices stays []
  }
  probeCache = { at: Date.now(), chatterbox, voices };
  return probeCache;
}

export async function GET() {
  const { chatterbox, voices } = await probeChatterbox();
  return NextResponse.json({
    enabled: Boolean(process.env.ELEVENLABS_API_KEY), // legacy field (elevenlabs)
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    chatterbox,
    voices,
  });
}

async function speakElevenLabs(text: string): Promise<NextResponse> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return NextResponse.json({ error: "elevenlabs_disabled" }, { status: 404 });
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_ELEVEN_VOICE;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
    // Every external call gets a deadline — a hung cloud API must not hold the route.
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return NextResponse.json({ error: "elevenlabs_error", status: res.status }, { status: 502 });
  return new NextResponse(res.body, { headers: { "content-type": "audio/mpeg" } });
}

async function speakChatterbox(text: string, voice: string | undefined, stream: boolean): Promise<NextResponse> {
  const voiceFile = voice ?? process.env.CHATTERBOX_VOICE ?? "Emily.wav";
  if (stream) {
    // Native /tts: streaming requires predefined voice mode; the response is
    // a chunked WAV (0xFFFFFFFF sizes) flushed as each text chunk finishes.
    const res = await fetch(`${chatterboxUrl()}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        voice_mode: "predefined",
        predefined_voice_id: voiceFile,
        stream: true,
        split_text: true,
        // 50 = server minimum; smaller chunks → earlier first audio on short
        // interviewer turns (the whole first chunk must synthesize before play).
        chunk_size: 50,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body)
      return NextResponse.json({ error: "chatterbox_error", status: res.status }, { status: 502 });
    return new NextResponse(res.body, { headers: { "content-type": "audio/wav" } });
  }
  // OpenAI-compatible endpoint; `voice` maps to a file in the server's
  // voices/ (predefined) or reference_audio/ (your cloned voices — drop a
  // 5-10s clip there or upload via the web UI at :8004).
  const res = await fetch(`${chatterboxUrl()}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "tts-1", // required by the OpenAI-compatible schema; value is ignored
      input: text,
      voice: voiceFile,
      response_format: "wav",
      speed: 1.0,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return NextResponse.json({ error: "chatterbox_error", status: res.status }, { status: 502 });
  return new NextResponse(res.body, { headers: { "content-type": "audio/wav" } });
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

  return parsed.data.engine === "chatterbox"
    ? speakChatterbox(parsed.data.text, parsed.data.voice, parsed.data.stream)
    : speakElevenLabs(parsed.data.text);
}
