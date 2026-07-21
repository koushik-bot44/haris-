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

/** Errors that mean the mic will never work this session — degrade immediately. */
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

export function initialSttState(): SttState {
  return {
    phase: "idle",
    finalSegments: [],
    interim: "",
    lastSpeechT: null,
    restartCount: 0,
    consecutiveErrors: 0,
    consecutiveNetworkErrors: 0,
    failReason: null,
    trace: [],
  };
}

export function fullTranscript(s: SttState): string {
  return [...s.finalSegments, s.interim].join(" ").replace(/\s+/g, " ").trim();
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
          const last = s.finalSegments[s.finalSegments.length - 1];
          if (last && (text.startsWith(last) || last.startsWith(text))) {
            s.finalSegments = [...s.finalSegments.slice(0, -1), text.length >= last.length ? text : last];
          } else {
            s.finalSegments = [...s.finalSegments, text];
          }
        }
        return { state: s, effect: null };
      }
      if (s.phase !== "listening") return { state: s, effect: null };
      s.trace.push({ kind: "result", t: action.t, text: action.text, isFinal: action.isFinal });
      if (action.isFinal) {
        const text = action.text.trim();
        if (text) s.finalSegments = [...s.finalSegments, text];
        s.interim = "";
      } else {
        s.interim = action.text;
      }
      if (action.text.trim()) {
        s.lastSpeechT = action.t;
        s.consecutiveErrors = 0;
        s.consecutiveNetworkErrors = 0;
      }
      return { state: s, effect: null };
    }

    case "SPEECH_ACTIVITY": {
      if (s.phase !== "listening") return { state: s, effect: null };
      s.lastSpeechT = action.t;
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
