"use client";

import {
  initialSttState,
  sttReduce,
  fullTranscript,
  type SttState,
} from "@/lib/stt-reducer";
import { startWhisperStt as startWhisperSttSync } from "@/lib/stt-whisper";

// Thin browser adapter around the pure reducer. All policy lives in
// lib/stt-reducer.ts; this file only wires Chrome's SpeechRecognition events
// into actions and executes the effects (restart / degrade).

type AnySpeechRecognition = {
  new (): SpeechRecognitionLike;
};
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export function sttSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

// ——— STT engine selection ———
// "auto": Chrome's recognizer when present, on-device Whisper otherwise.
// A network degrade (Brave/Chromium/VPN can't reach Google's speech servers)
// flips the setting to "whisper" so voice works in ANY browser, even offline.
const STT_ENGINE_KEY = "pds_stt_engine";
export type SttEngine = "auto" | "chrome" | "whisper";

export function getSttEngine(): SttEngine {
  if (typeof window === "undefined") return "auto";
  try {
    const v = window.localStorage.getItem(STT_ENGINE_KEY);
    return v === "chrome" || v === "whisper" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function setSttEngine(engine: SttEngine): void {
  try {
    window.localStorage.setItem(STT_ENGINE_KEY, engine);
  } catch {}
}

export interface SttSession {
  stop(): SttState;
  /** Stop, then wait for Chrome to finalize buffered audio (it delivers the
   * last final result AFTER recognition.stop()) and return the settled state.
   * Reading the transcript synchronously at stop() drops the final words. */
  stopAndSettle(settleMs?: number): Promise<SttState>;
  getState(): SttState;
}

export function startStt(callbacks: {
  onUpdate: (state: SttState) => void;
  onDegrade: (reason: string) => void;
}): SttSession | null {
  const engine = getSttEngine();
  if (engine === "whisper" || (engine === "auto" && !sttSupported())) {
    // Dynamic import keeps the transformers stack out of the main bundle;
    // startWhisperStt itself degrades if the model isn't ready yet.
    return startWhisperSttSync(callbacks);
  }
  if (!sttSupported()) {
    callbacks.onDegrade("unsupported");
    return null;
  }
  const w = window as unknown as Record<string, unknown>;
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as AnySpeechRecognition;

  let state = initialSttState();
  let stopped = false;
  let rec: SpeechRecognitionLike | null = null;

  const dispatch = (action: Parameters<typeof sttReduce>[1]) => {
    const out = sttReduce(state, action);
    state = out.state;
    callbacks.onUpdate(state);
    if (out.effect?.kind === "restart" && !stopped) {
      try {
        rec = makeRec();
        rec.start();
      } catch {
        // start() throws if called while already started — treat as recoverable;
        // the next onend will retry.
      }
    } else if (out.effect?.kind === "degrade_to_text") {
      stopped = true;
      try {
        rec?.abort();
      } catch {}
      callbacks.onDegrade(out.effect.reason);
    }
  };

  const makeRec = (): SpeechRecognitionLike => {
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-IN";
    r.onresult = (e) => {
      // Only the newest results matter; earlier indices were already dispatched.
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        dispatch({ type: "RESULT", t: Date.now(), text: res[0].transcript, isFinal: res.isFinal });
      }
    };
    r.onend = () => {
      if (!stopped) dispatch({ type: "ENGINE_END", t: Date.now() });
    };
    r.onerror = (e) => {
      dispatch({ type: "ERROR", t: Date.now(), error: e.error });
    };
    return r;
  };

  dispatch({ type: "START", t: Date.now() });
  rec = makeRec();
  try {
    rec.start();
  } catch {
    callbacks.onDegrade("start_failed");
    return null;
  }

  const doStop = () => {
    stopped = true;
    dispatch({ type: "STOP", t: Date.now() });
    try {
      // Handlers stay attached: results delivered after stop() flow into the
      // reducer's stopped-phase final handling instead of being lost.
      rec?.stop();
    } catch {}
    return state;
  };

  return {
    stop: doStop,
    async stopAndSettle(settleMs = 350) {
      doStop();
      await new Promise((r) => setTimeout(r, settleMs));
      return state;
    },
    getState() {
      return state;
    },
  };
}

export { fullTranscript };
