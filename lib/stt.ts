"use client";

import { initialSttState, sttReduce, fullTranscript, type SttState } from "@/lib/stt-reducer";
import { startWhisperStt } from "@/lib/stt-whisper";
import { startCloudStt } from "@/lib/stt-cloud";
import { startDeepgramStt } from "@/lib/stt-deepgram";

// Speech-to-text behind one interface. Four engines, in "auto" preference
// order (see pickSttEngine for WHY this is the order):
//   deepgram — live streaming recognition via a server-minted token (best;
//              interim results, any browser) when DEEPGRAM_API_KEY is set
//   cloud    — VAD-segmented utterances posted to /api/stt (Groq Whisper /
//              OpenAI / Deepgram) — any browser, near-live, and by far the most
//              accurate option on accented English
//   chrome   — the browser's SpeechRecognition (free, interim results; Chrome
//              and Safari, needs Google's speech service reachable)
//   whisper  — on-device whisper-tiny.en (~40MB download), fully offline
// "auto" picks the best one available; a degrade mid-session can swap the
// engine for this visit only (see setSttEngineEphemeral).
//
// Policy for surviving Chrome's recognizer lives in lib/stt-reducer.ts; this
// file wires events into actions and executes the effects (restart / degrade).

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
const STT_ENGINE_KEY = "pds_stt_engine";
export type SttEngine = "auto" | "chrome" | "whisper" | "cloud" | "deepgram";
type ConcreteEngine = Exclude<SttEngine, "auto">;

/** Session-only override (see setSttEngineEphemeral) — never persisted. */
let ephemeralEngine: SttEngine | null = null;

export function getSttEngine(): SttEngine {
  if (ephemeralEngine !== null) return ephemeralEngine;
  if (typeof window === "undefined") return "auto";
  try {
    const v = window.localStorage.getItem(STT_ENGINE_KEY);
    return v === "chrome" || v === "whisper" || v === "cloud" || v === "deepgram" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** Persist an explicit user preference. */
export function setSttEngine(engine: SttEngine): void {
  try {
    window.localStorage.setItem(STT_ENGINE_KEY, engine);
  } catch {}
}

/** Engine switch for the CURRENT visit only (e.g. a transient network degrade
 * routes to the cloud engine). localStorage is untouched, so one flaky moment
 * never permanently flips the browser off Chrome's recognizer. null clears it. */
export function setSttEngineEphemeral(engine: SttEngine | null): void {
  ephemeralEngine = engine;
}

export interface SttCapabilities {
  /** Server transcription provider for /api/stt, or null. */
  cloud: string | null;
  /** Deepgram live streaming available (token endpoint configured). */
  deepgramLive: boolean;
}

let caps: SttCapabilities | null = null;

/** Ask the server which speech engines exist. Cached for the visit; safe to
 * call repeatedly. A failed probe leaves the browser engines in charge. */
export async function resolveSttCapabilities(): Promise<SttCapabilities> {
  if (caps) return caps;
  try {
    const res = await fetch("/api/stt", { cache: "no-store" });
    if (!res.ok) throw new Error(`stt_${res.status}`);
    const d = (await res.json()) as Partial<SttCapabilities>;
    caps = { cloud: d.cloud ?? null, deepgramLive: Boolean(d.deepgramLive) };
  } catch {
    caps = { cloud: null, deepgramLive: false };
  }
  return caps;
}

export function sttCapabilities(): SttCapabilities | null {
  return caps;
}

/** The engine startStt will actually use right now.
 *
 * Accuracy order, not availability order. The server's Whisper path ("cloud")
 * now outranks Chrome's recognizer whenever the server reports a provider,
 * because on this project's actual users Chrome is the weak link: it mangles
 * Indian-accented English (a stored session reads "Expo hi myself Kaushik I am
 * building not Expo" for "Hi, myself Koushik, I am building an app"), it exists
 * only in Chrome/Safari, it needs Google's speech service reachable, and it
 * stops itself after ~60 seconds. Groq's whisper-large-v3-turbo transcribes the
 * same audio correctly, works in every browser, and the free tier is 2000
 * requests/day — an interview spends a few dozen. Chrome stays as the fallback
 * for a server with no transcription key configured. */
export function pickSttEngine(): ConcreteEngine {
  const e = getSttEngine();
  if (e !== "auto") return e;
  if (caps?.deepgramLive) return "deepgram";
  if (caps?.cloud) return "cloud";
  if (sttSupported()) return "chrome";
  return "whisper";
}

/** The engine to fall back to when `failed` degrades mid-session, or null when
 * nothing else is left. Same accuracy order as pickSttEngine, minus whatever
 * just broke — routing a cloud outage back to the cloud is an infinite loop. */
export function nextSttEngine(failed: ConcreteEngine): ConcreteEngine | null {
  const chain: ConcreteEngine[] = [];
  if (caps?.deepgramLive) chain.push("deepgram");
  if (caps?.cloud) chain.push("cloud");
  if (sttSupported()) chain.push("chrome");
  chain.push("whisper");
  return chain.find((c) => c !== failed) ?? null;
}

export interface SttSession {
  stop(): SttState;
  /** Stop, then wait for the engine to finalize buffered audio (Chrome
   * delivers the last final result AFTER recognition.stop()) and return the
   * settled state. Reading the transcript synchronously at stop() drops the
   * final words. */
  stopAndSettle(settleMs?: number): Promise<SttState>;
  getState(): SttState;
}

export interface SttCallbacks {
  onUpdate: (state: SttState) => void;
  onDegrade: (reason: string) => void;
}

export function startStt(callbacks: SttCallbacks): SttSession | null {
  switch (pickSttEngine()) {
    case "deepgram": {
      // If the live socket cannot be opened, fall through to the next best
      // engine for this session WITHOUT bothering the caller.
      const next = (): SttSession | null => {
        if (caps?.cloud) return startCloudStt(callbacks);
        if (sttSupported()) return startChromeStt(callbacks);
        return startWhisperStt(callbacks);
      };
      return startDeepgramStt(callbacks, next);
    }
    case "cloud":
      return startCloudStt(callbacks);
    case "whisper":
      return startWhisperStt(callbacks);
    case "chrome":
    default:
      if (!sttSupported()) {
        callbacks.onDegrade("unsupported");
        return null;
      }
      return startChromeStt(callbacks);
  }
}

export function startChromeStt(callbacks: SttCallbacks): SttSession | null {
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
    r.lang = process.env.NEXT_PUBLIC_STT_LANG || "en-IN";
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
