import type { SttTraceEvent } from "@/lib/types";

// Pure reducer for the SpeechRecognition wrapper. Chrome's recognizer
// auto-stops on silences/~60s and fires no-speech/network errors; the policy
// for surviving that lives here, fully testable with scripted event sequences —
// no mic, no browser. The thin adapter in lib/stt.ts feeds events in and
// executes the effects coming out.

export interface SttState {
  phase: "idle" | "listening" | "failed" | "stopped";
  /** Finalized transcript segments, accumulated ACROSS engine auto-restarts. */
  finalSegments: string[];
  interim: string;
  /** Silence-timer anchor: last speech-bearing result — OR the restart moment,
   * so an engine-restart gap is never counted as user silence. */
  lastSpeechT: number | null;
  restartCount: number;
  consecutiveErrors: number;
  /** Network errors specifically — only these degrade voice mode (attribution
   * matters: a no-speech blip followed by one network error must not kill voice). */
  consecutiveNetworkErrors: number;
  /** Errors that mean the ENGINE is not working (a transcription endpoint
   * returning 502, the on-device model throwing) as opposed to the ordinary
   * no-speech/aborted noise Chrome emits. Kept apart for the same attribution
   * reason as the network counter. */
  consecutiveEngineErrors: number;
  failReason: string | null;
  trace: SttTraceEvent[];
}

export type SttAction =
  | { type: "START"; t: number }
  | { type: "RESULT"; t: number; text: string; isFinal: boolean }
  /** Speech energy detected before any transcript exists (Whisper/VAD path) —
   * keeps the silence timer and level meter honest while transcription lags. */
  | { type: "SPEECH_ACTIVITY"; t: number }
  | { type: "ENGINE_END"; t: number } // recognizer stopped on its own
  | { type: "ERROR"; t: number; error: string }
  | { type: "STOP"; t: number }; // we intentionally stopped (answer ended)

export type SttEffect = { kind: "restart" } | { kind: "degrade_to_text"; reason: string } | null;

export const MAX_RESTARTS = 20;
export const MAX_CONSECUTIVE_ERRORS = 2;
/** Transcription failures in a row before the engine is declared broken. Three,
 * not two: a single Groq hiccup or a 429 must not cost the candidate their
 * voice, but an endpoint that is genuinely down has to hand over to the
 * fallback engine instead of silently recording nothing. */
export const MAX_ENGINE_ERRORS = 3;

/** Errors that mean the mic will never work this session — degrade immediately. */
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);
/** Routine recognizer noise: Chrome fires these constantly during silence and
 * on every stop(). They are not evidence of anything being wrong. */
const SOFT_ERRORS = new Set(["no-speech", "aborted", "network"]);

export function initialSttState(): SttState {
  return {
    phase: "idle",
    finalSegments: [],
    interim: "",
    lastSpeechT: null,
    restartCount: 0,
    consecutiveErrors: 0,
    consecutiveNetworkErrors: 0,
    consecutiveEngineErrors: 0,
    failReason: null,
    trace: [],
  };
}

export function fullTranscript(s: SttState): string {
  return [...s.finalSegments, s.interim].join(" ").replace(/\s+/g, " ").trim();
}

/** Comparison key for two transcript fragments: case, punctuation and spacing
 * removed. Every engine re-emits the same words dressed differently — Chrome
 * finalizes "my final answer is teamwork" as "My final answer is teamwork.",
 * Whisper re-punctuates an extended segment — so a raw prefix test sees two
 * unrelated strings and appends, duplicating the last sentence of nearly every
 * answer. The RAW text is always what gets stored; only the comparison is
 * normalized. */
export function dedupeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Is `next` the same utterance as `prev`, just revised? True when one is a
 * word-boundary prefix of the other — which is what a revision always looks
 * like, and what an unrelated new sentence essentially never does. */
function isRevisionOf(next: string, prev: string): boolean {
  const a = dedupeKey(next);
  const b = dedupeKey(prev);
  if (!a || !b) return false;
  if (a === b) return true;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  return long.startsWith(short + " ");
}

/** Append a final segment, merging it into the previous one when it is a
 * revision of it (keeping the longer, better-punctuated wording). */
function appendFinal(segments: string[], text: string): string[] {
  const last = segments[segments.length - 1];
  if (last && isRevisionOf(text, last)) {
    const keep = dedupeKey(text).length >= dedupeKey(last).length ? text : last;
    return [...segments.slice(0, -1), keep];
  }
  return [...segments, text];
}

export function sttReduce(state: SttState, action: SttAction): { state: SttState; effect: SttEffect } {
  const s: SttState = { ...state, trace: [...state.trace] };

  switch (action.type) {
    case "START": {
      s.trace.push({ kind: "start", t: action.t });
      s.phase = "listening";
      s.failReason = null;
      return { state: s, effect: null };
    }

    case "RESULT": {
      // Chrome finalizes buffered audio AFTER recognition.stop() — a final
      // result in the "stopped" phase is the last words of the answer, not
      // noise. It usually revises the interim we already promoted at STOP, so
      // replace that segment when the final extends it; otherwise append.
      if (s.phase === "stopped" && action.isFinal) {
        const text = action.text.trim();
        if (text) {
          s.trace.push({ kind: "result", t: action.t, text: action.text, isFinal: true });
          s.finalSegments = appendFinal(s.finalSegments, text);
        }
        return { state: s, effect: null };
      }
      if (s.phase !== "listening") return { state: s, effect: null };
      s.trace.push({ kind: "result", t: action.t, text: action.text, isFinal: action.isFinal });
      if (action.isFinal) {
        const text = action.text.trim();
        // Same merge as the stopped phase: an engine restart can re-deliver the
        // interim that ENGINE_END already promoted, and a segmenter's padded
        // boundaries can re-transcribe words the previous segment ended on.
        if (text) s.finalSegments = appendFinal(s.finalSegments, text);
        s.interim = "";
      } else {
        s.interim = action.text;
      }
      if (action.text.trim()) {
        // The anchor only ever moves FORWARD. Batch transcribers report the
        // wall-clock time a segment ENDED, which is already in the past when
        // the text comes back — and if the candidate resumed talking meanwhile,
        // a late segment would otherwise drag the silence anchor backwards and
        // end the answer mid-sentence.
        s.lastSpeechT = Math.max(s.lastSpeechT ?? action.t, action.t);
        s.consecutiveErrors = 0;
        s.consecutiveNetworkErrors = 0;
        s.consecutiveEngineErrors = 0;
      }
      return { state: s, effect: null };
    }

    case "SPEECH_ACTIVITY": {
      if (s.phase !== "listening") return { state: s, effect: null };
      s.lastSpeechT = Math.max(s.lastSpeechT ?? action.t, action.t);
      return { state: s, effect: null };
    }

    case "ENGINE_END": {
      // The engine stopping is NOT the answer ending — the 1.5s silence timer
      // owns end-of-answer. While listening, an engine end is auto-restarted
      // with the transcript preserved. Interim text at engine-end is promoted:
      // Chrome sometimes ends without finalizing the last hypothesis.
      if (s.phase !== "listening") return { state: s, effect: null };
      if (s.interim.trim()) {
        s.finalSegments = [...s.finalSegments, s.interim.trim()];
        s.interim = "";
      }
      if (s.restartCount >= MAX_RESTARTS) {
        s.phase = "failed";
        s.failReason = "too_many_restarts";
        return { state: s, effect: { kind: "degrade_to_text", reason: "too_many_restarts" } };
      }
      s.restartCount += 1;
      s.trace.push({ kind: "restart", t: action.t });
      // Refresh the silence anchor: the reconnect gap is engine latency, not
      // user silence — without this, the silence timer ends answers mid-sentence
      // whenever Chrome restarts during continuous speech.
      if (s.lastSpeechT !== null) s.lastSpeechT = action.t;
      return { state: s, effect: { kind: "restart" } };
    }

    case "ERROR": {
      s.trace.push({ kind: "error", t: action.t, error: action.error });
      if (s.phase !== "listening") return { state: s, effect: null };
      if (FATAL_ERRORS.has(action.error)) {
        s.phase = "failed";
        s.failReason = action.error;
        return { state: s, effect: { kind: "degrade_to_text", reason: action.error } };
      }
      // no-speech / network / aborted: retry once, then degrade. The retry is
      // carried by the ENGINE_END that Chrome fires right after the error —
      // here we only track the error budget. Attribution matters: only NETWORK
      // errors count toward the degrade budget (a no-speech blip followed by a
      // single network error must not kill voice mode).
      s.consecutiveErrors += 1;
      if (action.error === "network") {
        s.consecutiveNetworkErrors += 1;
        if (s.consecutiveNetworkErrors >= MAX_CONSECUTIVE_ERRORS) {
          s.phase = "failed";
          s.failReason = "network";
          return { state: s, effect: { kind: "degrade_to_text", reason: "network" } };
        }
        return { state: s, effect: null };
      }
      // A transcription endpoint erroring out (cloud_transcribe, the on-device
      // model throwing) used to be counted and then ignored forever: the mic
      // stayed "live" while every word vanished. Three in a row hands over.
      if (!SOFT_ERRORS.has(action.error)) {
        s.consecutiveEngineErrors += 1;
        if (s.consecutiveEngineErrors >= MAX_ENGINE_ERRORS) {
          s.phase = "failed";
          s.failReason = action.error;
          return { state: s, effect: { kind: "degrade_to_text", reason: action.error } };
        }
      }
      return { state: s, effect: null };
    }

    case "STOP": {
      s.trace.push({ kind: "stop", t: action.t });
      if (s.interim.trim()) {
        s.finalSegments = [...s.finalSegments, s.interim.trim()];
        s.interim = "";
      }
      s.phase = "stopped";
      return { state: s, effect: null };
    }
  }
}
