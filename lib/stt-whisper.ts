"use client";

// On-device Whisper STT — the answer to "Chrome's speech service is
// unreachable" when no server transcription is configured either
// (Brave/Arc/Chromium builds, VPNs, offline). whisper-tiny.en (~40MB, cached
// by the browser) transcribes locally on WebGPU or WASM. Segmentation, VAD
// and the reducer wiring live in lib/stt-segmented.ts; this file only owns
// the model lifecycle.

import type { SttState } from "@/lib/stt-reducer";
import type { SttSession } from "@/lib/stt";
import { startSegmentedStt } from "@/lib/stt-segmented";

type AsrPipeline = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string }>;

export type WhisperStatus = "off" | "loading" | "ready" | "failed";

let status: WhisperStatus = "off";
let asr: AsrPipeline | null = null;
let loadPromise: Promise<void> | null = null;

export function whisperStatus(): WhisperStatus {
  return status;
}

export function ensureWhisperLoading(): void {
  if (typeof window === "undefined" || loadPromise) return;
  status = "loading";
  loadPromise = (async () => {
    try {
      const { pipeline } = await import("@huggingface/transformers");
      const nav = navigator as Navigator & { gpu?: unknown };
      const device = nav.gpu ? "webgpu" : "wasm";
      const p = (await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
        dtype: device === "webgpu" ? "fp32" : "q8",
        device,
      })) as unknown as AsrPipeline;
      asr = p;
      status = "ready";
    } catch {
      status = "failed";
      asr = null;
    }
  })();
}

export function startWhisperStt(callbacks: {
  onUpdate: (state: SttState) => void;
  onDegrade: (reason: string) => void;
}): SttSession | null {
  if (status !== "ready" || !asr) {
    ensureWhisperLoading();
    callbacks.onDegrade(status === "failed" ? "whisper_failed" : "whisper_loading");
    return null;
  }
  const model = asr;
  return startSegmentedStt(async (audio) => (await model(audio)).text, callbacks, {
    settleMs: 3500,
    errorCode: "whisper_transcribe",
  });
}
