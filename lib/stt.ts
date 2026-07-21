"use client";

import {
  initialSttState,
  sttReduce,
  fullTranscript,
  type SttState,
} from "@/lib/stt-reducer";

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

export interface SttSession {
  stop(): SttState;
  getState(): SttState;
}

export function startStt(callbacks: {
  onUpdate: (state: SttState) => void;
  onDegrade: (reason: string) => void;
}): SttSession | null {
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

  return {
    stop() {
      stopped = true;
      dispatch({ type: "STOP", t: Date.now() });
      try {
        rec?.stop();
      } catch {}
      return state;
    },
    getState() {
      return state;
    },
  };
}

export { fullTranscript };
