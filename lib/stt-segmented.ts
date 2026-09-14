"use client";

// Segment-based speech-to-text — the shared engine under the on-device
// Whisper adapter AND the cloud transcription adapter. Batch transcribers
// (Whisper, Groq/OpenAI transcription endpoints) take an UTTERANCE, not a
// stream, so something else must (a) prove the mic hears you in real time and
// (b) decide where an utterance ends. That is the energy VAD (lib/vad.ts):
// it cuts segments at pauses, each segment is transcribed by the injected
// function, and the results flow into the same reducer as Chrome's
// recognizer — the machine, silence timer, and metrics work unchanged.

import { anySignal } from "@/lib/abort";
import { initialSttState, sttReduce, type SttState } from "@/lib/stt-reducer";
import type { SttSession } from "@/lib/stt";
import { DEFAULT_VAD, initialVadState, vadStep } from "@/lib/vad";

export const STT_TARGET_RATE = 16_000;

/** Nearest-sample downsample to 16 kHz — good enough for speech models. */
export function downsample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === STT_TARGET_RATE) return input;
  const ratio = fromRate / STT_TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}

/** Whisper-family models hallucinate stock phrases on silence/noise. A
 * segment that is ONLY one of these is dropped, never recorded as speech. */
const HALLUCINATION_RE =
  /^(?:thank you(?: for watching)?|thanks(?: for watching)?|you|bye|okay|\.|\s)*[.!]?$/i;

export function looksLikeHallucination(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^\[.*\]$/.test(t) || /^\(.*\)$/.test(t)) return true; // "[BLANK_AUDIO]", "(silence)"
  return HALLUCINATION_RE.test(t);
}

/** Rolling capture buffer with an HONEST sample timeline.
 *
 * The VAD reports segment boundaries as wall-clock instants, but the audio is
 * a sample buffer filled from a main-thread ScriptProcessor. Deriving a sample
 * index from `(t - captureStart) * rate` assumes every block arrived on time —
 * and the main thread is exactly where React renders, Monaco loads and the LLM
 * response is parsed, so blocks arrive late, and under real pressure the audio
 * hardware drops them entirely. Wall clock then runs AHEAD of the samples that
 * exist: a segment gets cut from the wrong place, or past the end of the
 * buffer, and words are lost or transcribed as somebody else's syllables.
 *
 * So the mapping is built from what was ACTUALLY written: each delivered block
 * records its own sample offset and the instant it arrived, and a time is
 * resolved by finding the block that covers it. Late blocks simply describe a
 * longer stretch of wall clock; dropped audio becomes a gap, and a time inside
 * a gap resolves to the nearest sample that really exists instead of an index
 * into nothing. Pure and unit-testable — no AudioContext involved. */
export class CaptureBuffer {
  private chunks: { data: Float32Array; startSample: number; startT: number; endT: number }[] = [];
  private droppedSamples = 0;
  private writtenSamples = 0;

  constructor(private readonly sampleRate: number) {}

  /** Oldest sample still retained (everything before it has been trimmed). */
  get firstSample(): number {
    return this.droppedSamples;
  }

  /** Total samples ever written — the end of the timeline. */
  get totalSamples(): number {
    return this.writtenSamples;
  }

  /** Record one delivered audio block. `t` is the wall clock at delivery, and
   * must be the same instant the VAD is fed, so a segment boundary lands on an
   * exact block edge rather than being interpolated. */
  push(data: Float32Array, t: number): void {
    const durMs = (data.length / this.sampleRate) * 1000;
    this.chunks.push({ data, startSample: this.writtenSamples, startT: t - durMs, endT: t });
    this.writtenSamples += data.length;
  }

  /** Wall-clock instant → sample index, clamped to audio that exists. */
  sampleAt(t: number): number {
    if (this.chunks.length === 0) return this.writtenSamples;
    const first = this.chunks[0];
    if (t <= first.startT) return first.startSample;
    for (const c of this.chunks) {
      if (t >= c.endT) continue;
      // A time inside a dropped-callback gap: that audio was never captured,
      // so the honest answer is where the next real audio begins.
      if (t <= c.startT) return c.startSample;
      const off = Math.round(((t - c.startT) / (c.endT - c.startT)) * c.data.length);
      return c.startSample + Math.min(c.data.length, Math.max(0, off));
    }
    return this.writtenSamples;
  }

  /** Copy [from, to) out of the retained window, clamped at both ends. */
  slice(from: number, to: number): Float32Array {
    const s = Math.max(from, this.droppedSamples);
    const e = Math.min(to, this.writtenSamples);
    if (e <= s) return new Float32Array(0);
    const out = new Float32Array(e - s);
    for (const c of this.chunks) {
      const cEnd = c.startSample + c.data.length;
      if (cEnd <= s) continue;
      if (c.startSample >= e) break;
      const from0 = Math.max(s, c.startSample) - c.startSample;
      const to0 = Math.min(e, cEnd) - c.startSample;
      out.set(c.data.subarray(from0, to0), Math.max(s, c.startSample) - s);
    }
    return out;
  }

  /** Release blocks entirely older than `sampleIndex` so a long answer never
   * balloons memory. */
  trimBefore(sampleIndex: number): void {
    while (this.chunks.length) {
      const c = this.chunks[0];
      const cEnd = c.startSample + c.data.length;
      if (cEnd > sampleIndex) break;
      this.droppedSamples = cEnd;
      this.chunks.shift();
    }
  }
}

export type SegmentTranscriber = (audio16k: Float32Array, signal: AbortSignal) => Promise<string>;

/** A transcription request that has not answered in this long is given up on
 * and retried once. Cloud Whisper answers in well under a second; a request
 * that takes twelve is a hung connection, not a slow one. */
export const SEGMENT_TIMEOUT_MS = 12_000;
export const SEGMENT_RETRY_DELAY_MS = 600;

export type SegmentOutcome = { outcome: "ok"; text: string } | { outcome: "empty" } | { outcome: "lost"; error: string } | { outcome: "aborted" };

/** One segment through the transcriber: a per-segment deadline, one retry on
 * failure or timeout, and an explicit outcome so the room can tell "no words
 * in this audio" from "the recogniser lost this audio". A failed segment used
 * to vanish silently, and the answer it belonged to came back as silence. */
export async function transcribeWithRetry(
  transcribe: SegmentTranscriber,
  audio: Float32Array,
  session: AbortSignal,
  opts: { timeoutMs?: number; retryDelayMs?: number; retries?: number } = {},
): Promise<SegmentOutcome> {
  const timeoutMs = opts.timeoutMs ?? SEGMENT_TIMEOUT_MS;
  const retries = opts.retries ?? 1;
  let lastError = "transcribe_failed";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (session.aborted) return { outcome: "aborted" };
    if (attempt > 0) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? SEGMENT_RETRY_DELAY_MS));
    const seg = new AbortController();
    const timer = setTimeout(() => seg.abort(new DOMException("segment timeout", "TimeoutError")), timeoutMs);
    try {
      const raw = await transcribe(audio, anySignal([session, seg.signal]));
      clearTimeout(timer);
      if (session.aborted) return { outcome: "aborted" };
      const text = raw.trim().replace(/^\[.*?\]\s*/g, "");
      if (!text || looksLikeHallucination(text)) return { outcome: "empty" };
      return { outcome: "ok", text };
    } catch (err) {
      clearTimeout(timer);
      if (session.aborted) return { outcome: "aborted" };
      const msg = err instanceof Error ? err.message : "";
      // No point retrying into the same rate-limited minute.
      if (msg === "rate_limited") return { outcome: "lost", error: "rate_limited" };
      lastError = seg.signal.aborted ? "timeout" : msg === "network" ? "network" : "transcribe_failed";
    }
  }
  return { outcome: "lost", error: lastError };
}

export interface SegmentedSttOptions {
  /** How long stopAndSettle waits for in-flight transcriptions. */
  settleMs?: number;
  /** Reducer error code when a transcription call fails. */
  errorCode?: string;
}

export function startSegmentedStt(
  transcribe: SegmentTranscriber,
  callbacks: { onUpdate: (state: SttState) => void; onDegrade: (reason: string) => void },
  opts: SegmentedSttOptions = {},
): SttSession {
  const settleDefault = opts.settleMs ?? 3000;
  const errorCode = opts.errorCode ?? "transcribe_failed";

  let state = initialSttState();
  let vad = initialVadState();
  let stopped = false;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  const inflight: Promise<void>[] = [];
  const abort = new AbortController();

  // Rolling capture buffer with a real (sample-counted) timeline. Old audio is
  // trimmed after every segment so a long answer never balloons memory.
  let sampleRate = 48_000;
  let capture = new CaptureBuffer(sampleRate);

  const dispatch = (action: Parameters<typeof sttReduce>[1]) => {
    const out = sttReduce(state, action);
    state = out.state;
    callbacks.onUpdate(state);
    if (out.effect?.kind === "degrade_to_text") {
      teardown();
      callbacks.onDegrade(out.effect.reason);
    }
  };

  const extract = (startT: number, endT: number): Float32Array =>
    // Pad the segment slightly so word edges survive the VAD boundaries.
    capture.slice(
      capture.sampleAt(startT) - Math.floor(sampleRate * 0.15),
      capture.sampleAt(endT) + Math.floor(sampleRate * 0.2),
    );

  const transcribeSegment = (startT: number, endT: number) => {
    const segment = extract(startT, endT);
    // Keep half a second before the segment end for the next segment's padding.
    capture.trimBefore(capture.sampleAt(endT) - Math.floor(sampleRate * 0.5));
    if (segment.length < sampleRate * 0.2) return;
    const audio = downsample(segment, sampleRate);
    dispatch({ type: "SEGMENT_SENT", t: Date.now() });
    const p = transcribeWithRetry(transcribe, audio, abort.signal).then((r) => {
      if (r.outcome === "aborted") return;
      if (r.outcome === "ok") {
        // Post-stop finals flow through the reducer's stopped-phase handling.
        dispatch({ type: "RESULT", t: endT, text: r.text, isFinal: true });
        dispatch({ type: "SEGMENT_SETTLED", t: Date.now(), outcome: "ok" });
        return;
      }
      if (r.outcome === "empty") {
        dispatch({ type: "SEGMENT_SETTLED", t: Date.now(), outcome: "empty" });
        return;
      }
      const code = r.error === "rate_limited" ? "cloud_rate_limited" : r.error === "network" || r.error === "timeout" ? "network" : errorCode;
      dispatch({ type: "SEGMENT_SETTLED", t: Date.now(), outcome: "lost" });
      dispatch({ type: "ERROR", t: Date.now(), error: code });
    });
    inflight.push(p);
  };

  const teardown = () => {
    stopped = true;
    try {
      processor?.disconnect();
    } catch {}
    try {
      void ctx?.close();
    } catch {}
    stream?.getTracks().forEach((tr) => tr.stop());
  };

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
    capture = new CaptureBuffer(sampleRate);
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but universally supported and sufficient
    // for a 4096-sample RMS + capture tap.
    processor = ctx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    // A ScriptProcessor only runs while connected to the destination; a zero
    // gain node keeps the mic from being played back through the speakers.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(ctx.destination);
    dispatch({ type: "START", t: Date.now() });

    processor.onaudioprocess = (e) => {
      if (stopped) return;
      // ONE timestamp for the block and the VAD tick it produces: that identity
      // is what makes a segment boundary map back to an exact sample offset.
      const t = Date.now();
      const data = e.inputBuffer.getChannelData(0);
      capture.push(new Float32Array(data), t);
      let sum = 0;
      for (let i = 0; i < data.length; i += 8) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / (data.length / 8));
      const out = vadStep(vad, rms, t, DEFAULT_VAD);
      vad = out.state;
      if (out.event?.kind === "activity") dispatch({ type: "SPEECH_ACTIVITY", t });
      else if (out.event?.kind === "segment") transcribeSegment(out.event.startT, out.event.endT);
    };
  })();

  const finishPendingSegment = () => {
    // Cut whatever is mid-flight so the last words get transcribed.
    if (vad.segmentStartT !== null && vad.lastSpeechT !== null) {
      transcribeSegment(vad.segmentStartT, vad.lastSpeechT);
      vad = { ...vad, segmentStartT: null };
    }
  };

  return {
    stop() {
      finishPendingSegment();
      dispatch({ type: "STOP", t: Date.now() });
      abort.abort();
      teardown();
      return state;
    },
    async stopAndSettle(settleMs = settleDefault) {
      finishPendingSegment();
      dispatch({ type: "STOP", t: Date.now() });
      // Keep transcription promises running; only the capture stops.
      stopped = true;
      try {
        processor?.disconnect();
      } catch {}
      await Promise.race([Promise.allSettled(inflight), new Promise((r) => setTimeout(r, settleMs))]);
      abort.abort();
      try {
        void ctx?.close();
      } catch {}
      stream?.getTracks().forEach((tr) => tr.stop());
      return state;
    },
    getState() {
      return state;
    },
  };
}
