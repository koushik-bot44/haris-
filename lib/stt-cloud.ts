"use client";

// Cloud transcription STT — works in ANY browser with a microphone. The mic
// is VAD-segmented on-device (lib/stt-segmented.ts); each utterance is posted
// as a small 16 kHz WAV to /api/stt, where the server forwards it to Groq
// Whisper / OpenAI / Deepgram. Near-live: a segment is transcribed the moment
// the speaker pauses, in a few hundred milliseconds.

import type { SttState } from "@/lib/stt-reducer";
import type { SttSession } from "@/lib/stt";
import { startSegmentedStt, STT_TARGET_RATE } from "@/lib/stt-segmented";
import { float32ToPcm16, pcmToWav } from "@/lib/pcm-wav";

async function transcribeViaServer(audio16k: Float32Array, signal: AbortSignal): Promise<string> {
  const wav = pcmToWav(float32ToPcm16(audio16k), { sampleRate: STT_TARGET_RATE, channels: 1, bitsPerSample: 16 });
  const form = new FormData();
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "segment.wav");
  let res: Response;
  try {
    res = await fetch("/api/stt", { method: "POST", body: form, signal });
  } catch (err) {
    if (signal.aborted) return "";
    throw new Error("network");
  }
  if (res.status === 404) throw new Error("stt_disabled");
  if (!res.ok) throw new Error(`stt_${res.status}`);
  const d = (await res.json()) as { text?: string };
  return typeof d.text === "string" ? d.text : "";
}

export function startCloudStt(callbacks: {
  onUpdate: (state: SttState) => void;
  onDegrade: (reason: string) => void;
}): SttSession {
  return startSegmentedStt(transcribeViaServer, callbacks, { settleMs: 2500, errorCode: "cloud_transcribe" });
}
