"use client";

// On-device Whisper STT — the plan's M0 answer to "Chrome's speech service is
// unreachable" (Brave/Arc/Chromium builds, VPNs, offline). whisper-tiny.en
// (~40MB, cached by the browser) transcribes locally on WebGPU or WASM; a VAD
// (lib/vad.ts) proves the mic hears you in real time and cuts utterance
// segments for transcription. Emits the SAME reducer actions as the Chrome
// adapter, so the machine, silence timer, and metrics all work unchanged.

import {
  initialSttState,
  sttReduce,
  type SttState,
} from "@/lib/stt-reducer";
import type { SttSession } from "@/lib/stt";
import { DEFAULT_VAD, initialVadState, vadStep } from "@/lib/vad";

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
      })) as unknown as (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string }>;
      asr = p;
      status = "ready";
    } catch {
      status = "failed";
      asr = null;
    }
  })();
}

const TARGET_RATE = 16_000;

function downsample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE) return input;
  const ratio = fromRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    out[i] = input[Math.floor(i * ratio)];
  }
  return out;
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

  let state = initialSttState();
  let vad = initialVadState();
  let stopped = false;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  const inflight: Promise<void>[] = [];

  // Rolling capture buffer: absolute-ish timeline via sample counting.
  const buffers: Float32Array[] = [];
  let capturedSamples = 0;
  let captureStartT = 0;
  let sampleRate = 48_000;

  const dispatch = (action: Parameters<typeof sttReduce>[1]) => {
    const out = sttReduce(state, action);
    state = out.state;
    callbacks.onUpdate(state);
    if (out.effect?.kind === "degrade_to_text") {
      teardown();
      callbacks.onDegrade(out.effect.reason);
    }
  };

  const samplesAt = (t: number) => Math.max(0, Math.floor(((t - captureStartT) / 1000) * sampleRate));

  const extract = (startT: number, endT: number): Float32Array => {
    const all = new Float32Array(capturedSamples);
    let off = 0;
    for (const b of buffers) {
      all.set(b, off);
      off += b.length;
    }
    // Pad the segment slightly so word edges survive the VAD boundaries.
    const s = Math.max(0, samplesAt(startT) - Math.floor(sampleRate * 0.15));
    const e = Math.min(all.length, samplesAt(endT) + Math.floor(sampleRate * 0.2));
    return all.slice(s, e);
  };

  const transcribe = (startT: number, endT: number) => {
    const segment = extract(startT, endT);
    if (segment.length < sampleRate * 0.2) return;
    const audio = downsample(segment, sampleRate);
    const p = asr!(audio)
      .then((res) => {
        const text = res.text.trim().replace(/^\[.*?\]\s*/g, "");
        if (!stopped || state.phase === "stopped") {
          // Post-stop finals flow through the reducer's stopped-phase handling.
          if (text && !/^\(.*\)$/.test(text)) {
            dispatch({ type: "RESULT", t: endT, text, isFinal: true });
          }
        }
      })
      .catch(() => {
        dispatch({ type: "ERROR", t: Date.now(), error: "whisper_transcribe" });
      });
    inflight.push(p.then(() => {}));
  };

  const teardown = () => {
    stopped = true;
    try {
      processor?.disconnect();
      ctx?.close();
    } catch {}
    stream?.getTracks().forEach((tr) => tr.stop());
  };

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      callbacks.onDegrade("not-allowed");
      return;
    }
    if (stopped) {
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }
    ctx = new AudioContext();
    sampleRate = ctx.sampleRate;
    captureStartT = Date.now();
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but universally supported and sufficient
    // for a 4096-sample RMS + capture tap; an AudioWorklet is the M2 upgrade.
    processor = ctx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(ctx.destination);
    dispatch({ type: "START", t: Date.now() });

    processor.onaudioprocess = (e) => {
      if (stopped) return;
      const data = e.inputBuffer.getChannelData(0);
      buffers.push(new Float32Array(data));
      capturedSamples += data.length;
      let sum = 0;
      for (let i = 0; i < data.length; i += 8) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / (data.length / 8));
      const t = Date.now();
      const out = vadStep(vad, rms, t, DEFAULT_VAD);
      vad = out.state;
      if (out.event?.kind === "activity") dispatch({ type: "SPEECH_ACTIVITY", t });
      else if (out.event?.kind === "segment") transcribe(out.event.startT, out.event.endT);
    };
  })();

  const finishPendingSegment = () => {
    // Cut whatever is mid-flight so the last words get transcribed.
    if (vad.segmentStartT !== null && vad.lastSpeechT !== null) {
      transcribe(vad.segmentStartT, vad.lastSpeechT);
      vad = { ...vad, segmentStartT: null };
    }
  };

  return {
    stop() {
      finishPendingSegment();
      dispatch({ type: "STOP", t: Date.now() });
      teardown();
      return state;
    },
    async stopAndSettle(settleMs = 3500) {
      finishPendingSegment();
      dispatch({ type: "STOP", t: Date.now() });
      // Keep transcription promises running; only the capture stops.
      stopped = true;
      try {
        processor?.disconnect();
      } catch {}
      await Promise.race([Promise.allSettled(inflight), new Promise((r) => setTimeout(r, settleMs))]);
      try {
        ctx?.close();
      } catch {}
      stream?.getTracks().forEach((tr) => tr.stop());
      return state;
    },
    getState() {
      return state;
    },
  };
}
