"use client";

// Kokoro-82M on-device TTS — the natural voice that costs nothing: the model
// downloads once (cached by the browser), then all speech is generated
// locally. WebGPU when a usable adapter exists, WASM otherwise — and a WebGPU
// load that fails falls back to WASM instead of leaving the candidate with the
// system voice for the rest of the session.
//
// The download is NOT hidden behind the system voice any more. A real-browser
// run (2026-08-25, fresh profile) measured why: the model took ~50 s to arrive,
// the 8 s hold in lib/tts.ts expired, and the greeting plus the whole second
// turn were spoken by the robotic system voice before Kokoro took over — a
// first-time visitor's "the interviewer has two voices". The interview now
// waits in the preroll, with this module's progress on screen, until the
// voice is ready (hooks/useInterviewMachine.ts voiceWarmup).

import { tapPlayback } from "@/lib/audio-viz";

type KokoroModel = {
  generate(text: string, opts: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }>;
};
type ProgressEvent = { status?: string; file?: string; progress?: number; loaded?: number; total?: number };
type KokoroCtor = {
  from_pretrained(
    id: string,
    opts: { dtype: string; device: string; progress_callback?: (e: ProgressEvent) => void },
  ): Promise<unknown>;
};

export type KokoroStatus = "off" | "loading" | "ready" | "failed";
type Device = "webgpu" | "wasm";

let status: KokoroStatus = "off";
let model: KokoroModel | null = null;
let loadPromise: Promise<void> | null = null;
let audioCtx: AudioContext | null = null;
/** Bytes seen per file during the download — the model is several files. */
const fileProgress = new Map<string, { loaded: number; total: number }>();

export const PRIYA_VOICE = "af_heart";
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

export function kokoroStatus(): KokoroStatus {
  return status;
}

/** Download progress 0–100 while loading (null before the first byte and
 * after the model is ready) — for the preroll's "preparing the voice" line. */
export function kokoroProgress(): number | null {
  if (status !== "loading" || fileProgress.size === 0) return null;
  let loaded = 0;
  let total = 0;
  for (const f of fileProgress.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  return total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null;
}

/** WebGPU is only worth trying when an adapter actually exists — `navigator.gpu`
 * being present says nothing about that (headless, blocked, software GL). */
async function pickDevice(): Promise<Device> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } };
  if (!nav.gpu?.requestAdapter) return "wasm";
  try {
    const adapter = await nav.gpu.requestAdapter();
    return adapter ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

async function load(Kokoro: KokoroCtor, device: Device): Promise<KokoroModel> {
  // WASM gets q8 (~90 MB, what the model card recommends); WebGPU gets fp32
  // (~330 MB — measured 325,532,232 bytes) because the quantized graph is
  // known to produce noise on WebGPU. Both are a one-time download the
  // browser caches; the preroll shows the progress instead of hiding it.
  fileProgress.clear();
  return (await Kokoro.from_pretrained(MODEL_ID, {
    dtype: device === "webgpu" ? "fp32" : "q8",
    device,
    progress_callback: (e) => {
      if (!e?.file || typeof e.loaded !== "number" || typeof e.total !== "number") return;
      fileProgress.set(e.file, { loaded: e.loaded, total: e.total });
    },
  })) as KokoroModel;
}

export function ensureKokoroLoading(): void {
  if (typeof window === "undefined" || loadPromise) return;
  status = "loading";
  loadPromise = (async () => {
    try {
      const { KokoroTTS } = (await import("kokoro-js")) as unknown as { KokoroTTS: KokoroCtor };
      const device = await pickDevice();
      try {
        model = await load(KokoroTTS, device);
      } catch (err) {
        if (device !== "webgpu") throw err;
        console.warn("[kokoro] WebGPU load failed, retrying on WASM:", err instanceof Error ? err.message : err);
        model = await load(KokoroTTS, "wasm");
      }
      // Warm the graph before the first real line. The first generate() pays
      // a one-time cost (ONNX session init, WebGPU shader compile) that a
      // real-browser run measured as 5.4 s to the greeting's first syllable
      // against 2.3–3.7 s for every later turn. Spending it here, while the
      // candidate is still reading the preroll, means the interview opens at
      // the steady-state latency. The result is discarded; failure is
      // harmless (the real line would pay the same cost, as before).
      try {
        await model.generate("Hello.", { voice: PRIYA_VOICE });
      } catch {}
      status = "ready";
    } catch (err) {
      console.warn("[kokoro] on-device voice unavailable:", err instanceof Error ? err.message : err);
      status = "failed";
      model = null;
      loadPromise = null; // a later ensureKokoroLoading() may retry
    }
  })();
}

function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

/** Resolve once the model can actually speak, or false when it failed or the
 * wait ran out. Callers hold a line for this instead of speaking THAT line in
 * a different voice: a mid-reply engine switch is the "multiple voices" bug. */
export function kokoroReady(timeoutMs: number): Promise<boolean> {
  if (status === "ready") return Promise.resolve(true);
  if (typeof window === "undefined") return Promise.resolve(false);
  ensureKokoroLoading();
  if (status === "failed") return Promise.resolve(false);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      if (status === "ready") return resolve(true);
      if (status === "failed" || Date.now() - startedAt >= timeoutMs) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
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
      // Watchdog: a suspended context never fires onended — the interview
      // must not hang on it.
      const guard = setTimeout(resolve, buf.duration * 1000 + 1500);
      src.onended = () => {
        clearTimeout(guard);
        resolve();
      };
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
      next?.catch(() => {}); // a rejected look-ahead is re-awaited on its turn
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
