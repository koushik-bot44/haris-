// Energy-based voice activity detection + segmentation — pure and testable.
// Drives the on-device Whisper adapter: while SpeechRecognition streams words,
// Whisper transcribes SEGMENTS, so something else must (a) prove the mic hears
// you in real time and (b) decide where an utterance ends. That's this.

export interface VadConfig {
  enterRms: number; // speech starts above this (hysteresis high)
  exitRms: number; // speech ends below this (hysteresis low)
  silenceCutMs: number; // this much silence after speech cuts a segment
  maxSegmentMs: number; // force-cut runaway segments
  minSegmentMs: number; // shorter than this = noise, dropped
}

export const DEFAULT_VAD: VadConfig = {
  enterRms: 0.015,
  exitRms: 0.008,
  silenceCutMs: 700,
  maxSegmentMs: 10_000,
  minSegmentMs: 300,
};

export interface VadState {
  speaking: boolean;
  segmentStartT: number | null;
  lastSpeechT: number | null;
}

export type VadEvent =
  | { kind: "activity"; t: number }
  | { kind: "segment"; startT: number; endT: number }
  | null;

export function initialVadState(): VadState {
  return { speaking: false, segmentStartT: null, lastSpeechT: null };
}

/** Feed one RMS sample; returns an event when something happened. */
export function vadStep(
  state: VadState,
  rms: number,
  t: number,
  cfg: VadConfig = DEFAULT_VAD,
): { state: VadState; event: VadEvent } {
  const s = { ...state };

  if (!s.speaking) {
    if (rms >= cfg.enterRms) {
      s.speaking = true;
      if (s.segmentStartT === null) s.segmentStartT = t;
      s.lastSpeechT = t;
      return { state: s, event: { kind: "activity", t } };
    }
    // Silence while a segment is pending → cut it once the gap is long enough.
    if (s.segmentStartT !== null && s.lastSpeechT !== null && t - s.lastSpeechT >= cfg.silenceCutMs) {
      const seg = { kind: "segment" as const, startT: s.segmentStartT, endT: s.lastSpeechT };
      s.segmentStartT = null;
      if (seg.endT - seg.startT < cfg.minSegmentMs) return { state: s, event: null }; // noise blip
      return { state: s, event: seg };
    }
    return { state: s, event: null };
  }

  // speaking
  if (rms >= cfg.exitRms) {
    s.lastSpeechT = t;
    // Force-cut marathon segments so transcription latency stays bounded.
    if (s.segmentStartT !== null && t - s.segmentStartT >= cfg.maxSegmentMs) {
      const seg = { kind: "segment" as const, startT: s.segmentStartT, endT: t };
      s.segmentStartT = t; // next segment continues seamlessly
      return { state: s, event: seg };
    }
    return { state: s, event: { kind: "activity", t } };
  }
  s.speaking = false;
  return { state: s, event: null };
}
