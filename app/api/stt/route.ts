import { NextResponse } from "next/server";
import { deepgramLiveEnabled, sttProvider, transcribeAudio } from "@/lib/stt-server";

// Cloud transcription for browsers without a usable built-in recognizer (and
// for anyone who wants Whisper-grade accuracy). The client posts ONE short
// utterance per request — a 16 kHz mono WAV cut by the on-device VAD — so a
// request is a few hundred KB at most. GET reports what is configured.

export const maxDuration = 30;

/** Utterances are ≤ ~12 s of 16 kHz PCM16 (~400 KB); anything bigger is not
 * a segment from our client. */
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = /^audio\/(wav|x-wav|wave|webm|ogg|mp4|mpeg|mp3|flac|m4a)/i;

export async function GET() {
  return NextResponse.json(
    { cloud: sttProvider(), deepgramLive: deepgramLiveEnabled() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  if (!sttProvider()) {
    return NextResponse.json({ error: "stt_disabled", message: "No cloud transcription is configured." }, { status: 404 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data with an `audio` file" }, { status: 400 });
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob)) return NextResponse.json({ error: "missing audio" }, { status: 400 });
  if (audio.size === 0) return NextResponse.json({ text: "", provider: sttProvider() });
  if (audio.size > MAX_BYTES) return NextResponse.json({ error: "audio too large" }, { status: 413 });
  const type = audio.type || "audio/wav";
  if (!ALLOWED_TYPES.test(type)) return NextResponse.json({ error: "unsupported audio type" }, { status: 415 });
  const languageRaw = form.get("language");
  const language = typeof languageRaw === "string" && /^[a-z]{2}$/i.test(languageRaw) ? languageRaw.toLowerCase() : "en";
  const promptRaw = form.get("prompt");
  const prompt = typeof promptRaw === "string" ? promptRaw.slice(0, 500) : undefined;
  const ext = /webm/.test(type) ? "webm" : /ogg/.test(type) ? "ogg" : /mp4|m4a/.test(type) ? "m4a" : /mpeg|mp3/.test(type) ? "mp3" : /flac/.test(type) ? "flac" : "wav";

  try {
    const { text, provider } = await transcribeAudio(audio, `segment.${ext}`, { language, prompt, signal: req.signal });
    return NextResponse.json({ text, provider }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    if (!aborted) console.warn("[stt] transcription failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: aborted ? "stt_timeout" : "stt_error" }, { status: 502 });
  }
}
