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
  // The cut is the first link in the reply chain: nothing can be transcribed,
  // and therefore nothing can be answered, until a segment closes. 600ms sits
  // below the shortest end-of-turn pause the listen policy will accept
  // (PAUSE_END_FAST_MS, 700ms), so the last words are already on their way to
  // the transcriber by the time the turn is handed back — while staying long
  // enough that a between-words breath does not chop a sentence in half.
  silenceCutMs: 600,
  maxSegmentMs: 10_000,
  // A segment's length is measured between BLOCK timestamps (a 4096-sample
  // block at 48 kHz is ~85ms, and startT is the end of the first loud block),
  // so a real utterance always measures one block SHORT of its true length. At
  // the old 300ms floor a spoken "Yes." or "No." (≈250–350ms, three or four
  // loud blocks → 170–255ms measured) was filed as a noise blip and never
  // transcribed: the candidate answered and the room heard nothing, nudged
  // them, and eventually recorded "(no answer)". 150ms keeps any monosyllable
  // that spans three blocks; a shorter click still never reaches the
  // transcriber, and Whisper's hallucination filter catches what does.
  minSegmentMs: 150,
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
