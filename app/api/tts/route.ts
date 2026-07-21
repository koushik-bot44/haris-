import { NextResponse } from "next/server";
import { z } from "zod";

// ElevenLabs proxy — the "best voices" engine, active only when
// ELEVENLABS_API_KEY exists in env (their free signup tier works; ~10k
// chars/month). Key stays server-side. Kokoro remains the no-key premium
// path; system voice the instant floor.

const bodySchema = z.object({
  text: z.string().min(1).max(1200),
});

const DEFAULT_VOICE = "21m00Tcgm4TlvDq8ikWAM"; // Rachel — warm, professional

export async function GET() {
  return NextResponse.json({ enabled: Boolean(process.env.ELEVENLABS_API_KEY) });
}

export async function POST(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return NextResponse.json({ error: "elevenlabs_disabled" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid shape" }, { status: 400 });

  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text: parsed.data.text, model_id: "eleven_turbo_v2_5" }),
  });
  if (!res.ok) {
    return NextResponse.json({ error: "elevenlabs_error", status: res.status }, { status: 502 });
  }
  return new NextResponse(res.body, { headers: { "content-type": "audio/mpeg" } });
}
