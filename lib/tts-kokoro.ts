"use client";

// Kokoro-82M on-device TTS — the plan's M0 "premium voice" path, ₹0 forever:
// the model downloads once (~80–90MB, cached by the browser), then all speech
// is generated locally (WebGPU when available, WASM otherwise). Dramatically
// better voices than speechSynthesis — af_heart for Priya, distinct voices per
// GD persona later. Hybrid rule: while the model is still downloading, the
// system voice speaks; Kokoro takes over seamlessly once ready.

import { tapPlayback } from "@/lib/audio-viz";

type KokoroModel = {
  generate(text: string, opts: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

export type KokoroStatus = "off" | "loading" | "ready" | "failed";

let status: KokoroStatus = "off";
let model: KokoroModel | null = null;
let loadPromise: Promise<void> | null = null;
let audioCtx: AudioContext | null = null;

export const PRIYA_VOICE = "af_heart";

export function kokoroStatus(): KokoroStatus {
  return status;
}

export function ensureKokoroLoading(): void {
  if (typeof window === "undefined" || loadPromise) return;
  status = "loading";
  loadPromise = (async () => {
    try {
      const { KokoroTTS } = await import("kokoro-js");
      const nav = navigator as Navigator & { gpu?: unknown };
      const device = nav.gpu ? "webgpu" : "wasm";
      model = (await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: device === "webgpu" ? "fp32" : "q8",
        device,
      })) as unknown as KokoroModel;
      status = "ready";
    } catch {
      status = "failed";
      model = null;
    }
  })();
}

function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

export interface KokoroHandle {
  done: Promise<void>;
  cancel(): void;
  firstSyllableAt: Promise<number>;
}

/** Speak sentence chunks sequentially, prefetching the next chunk's audio
 * while the current one plays. Cancel stops playback and abandons the queue. */
export function kokoroSpeak(chunks: string[], voice: string): KokoroHandle {
  let cancelled = false;
  let currentSource: AudioBufferSourceNode | null = null;
  let resolveFirst!: (t: number) => void;
  const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));

  const gen = (text: string) => model!.generate(text, { voice });

  const playBuffer = (audio: Float32Array, samplingRate: number) =>
    new Promise<void>((resolve) => {
      if (cancelled) return resolve();
      const c = ctx();
      const buf = c.createBuffer(1, audio.length, samplingRate);
      buf.copyToChannel(new Float32Array(audio), 0);
      const src = c.createBufferSource();
      src.buffer = buf;
      tapPlayback(c, src); // orb rides the real playback amplitude
      src.onended = () => resolve();
      currentSource = src;
      src.start();
    });

  const done = (async () => {
    let first = true;
    let next: Promise<{ audio: Float32Array; sampling_rate: number }> | null = chunks.length
      ? gen(chunks[0])
      : null;
    for (let i = 0; i < chunks.length; i++) {
      if (cancelled || !next) break;
      let audio;
      try {
        audio = await next;
      } catch {
        break; // one failed chunk must not hang the interview
      }
      next = i + 1 < chunks.length ? gen(chunks[i + 1]) : null;
      if (cancelled) break;
      if (first) {
        first = false;
        resolveFirst(Date.now());
      }
      await playBuffer(audio.audio, audio.sampling_rate);
    }
    if (first) resolveFirst(Date.now());
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      try {
        currentSource?.stop();
      } catch {}
    },
    firstSyllableAt,
  };
}
