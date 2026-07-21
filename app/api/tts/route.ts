import { NextResponse } from "next/server";
import { z } from "zod";

// Server-voice proxy for two engines:
// - chatterbox: the LOCAL Chatterbox-TTS-Server (localhost:8004, MPS) —
//   studio-grade voice + zero-shot cloning, fully offline, no keys.
// - elevenlabs: cloud, active only when ELEVENLABS_API_KEY exists (free
//   signup tier). Key stays server-side.
// Kokoro remains the in-browser premium path; system voice the instant floor.

const bodySchema = z.object({
  text: z.string().min(1).max(1200),
  engine: z.enum(["elevenlabs", "chatterbox"]).default("elevenlabs"),
});

const DEFAULT_ELEVEN_VOICE = "21m00Tcgm4TlvDq8ikWAM"; // Rachel — warm, professional

function chatterboxUrl(): string {
  return process.env.CHATTERBOX_URL ?? "http://127.0.0.1:8004";
}

async function chatterboxAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${chatterboxUrl()}/api/ui/initial-data`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  return NextResponse.json({
    enabled: Boolean(process.env.ELEVENLABS_API_KEY), // legacy field (elevenlabs)
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    chatterbox: await chatterboxAlive(),
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
  });
  if (!res.ok) return NextResponse.json({ error: "elevenlabs_error", status: res.status }, { status: 502 });
  return new NextResponse(res.body, { headers: { "content-type": "audio/mpeg" } });
}

async function speakChatterbox(text: string): Promise<NextResponse> {
  // OpenAI-compatible endpoint; `voice` maps to a file in the server's
  // voices/ (predefined) or reference_audio/ (your cloned voices — drop a
  // 5-10s clip there or upload via the web UI at :8004).
  const res = await fetch(`${chatterboxUrl()}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: text,
      voice: process.env.CHATTERBOX_VOICE ?? "Emily.wav",
      response_format: "wav",
      speed: 1.0,
    }),
    signal: AbortSignal.timeout(60_000),
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
    ? speakChatterbox(parsed.data.text)
    : speakElevenLabs(parsed.data.text);
}
