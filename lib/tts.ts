"use client";

// TTS with four engines behind one interface:
// - chatterbox (local server): studio voices, STREAMED — the first synthesized
//   chunk plays while the rest is still rendering. The default engine.
// - kokoro (on-device neural): premium voices once its model is downloaded.
// - elevenlabs (cloud): active only when the server holds a key.
// - system (speechSynthesis): instant, robotic; the floor that never fails —
//   the three Chrome traps handled (voices race, long-utterance stall,
//   background-tab pause).
// Per-utterance runtime chain: chatterbox → kokoro (if ready) → system.

import { ensureKokoroLoading, kokoroSpeak, kokoroStatus, PRIYA_VOICE, type KokoroHandle } from "@/lib/tts-kokoro";
import { setAiHue, startPseudoTalking, stopPseudoTalking, tapPlayback } from "@/lib/audio-viz";
import { concatBytes, nextChunkStartTime, parseWavHeader, pcm16ToFloat32 } from "@/lib/wav";

const ENGINE_KEY = "pds_voice_engine";

export type VoiceEngine = "system" | "kokoro" | "elevenlabs" | "chatterbox";

export function getVoiceEngine(): VoiceEngine {
  if (typeof window === "undefined") return "chatterbox";
  try {
    const v = window.localStorage.getItem(ENGINE_KEY);
    return v === "system" || v === "kokoro" || v === "elevenlabs" || v === "chatterbox" ? v : "chatterbox";
  } catch {
    return "chatterbox";
  }
}

/** True when the user has ever explicitly picked a voice (any value stored). */
export function hasStoredVoiceChoice(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(ENGINE_KEY) !== null;
  } catch {
    return true;
  }
}

export function setVoiceEngine(engine: VoiceEngine): void {
  try {
    window.localStorage.setItem(ENGINE_KEY, engine);
  } catch {}
  if (engine === "kokoro") ensureKokoroLoading();
}

export { kokoroStatus, ensureKokoroLoading };

let lastEngine: VoiceEngine | null = null;

/** Engine that actually spoke the most recent utterance (UI badge). */
export function lastEngineUsed(): VoiceEngine | null {
  return lastEngine;
}

// ONE AudioContext for all server-voice playback — per-call contexts leak
// (Chrome caps them) and defeat gapless chunk scheduling.
let audioCtx: AudioContext | null = null;
function sharedCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!voicesReady) {
    voicesReady = new Promise((resolve) => {
      const existing = window.speechSynthesis.getVoices();
      if (existing.length > 0) return resolve(existing);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve(window.speechSynthesis.getVoices());
      };
      window.speechSynthesis.addEventListener("voiceschanged", settle, { once: true });
      // Some engines never fire voiceschanged — don't hang the interview.
      setTimeout(settle, 1500);
    });
  }
  return voicesReady;
}

function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const prefs = [/en-IN/i, /en-GB/i, /en-US/i, /^en/i];
  for (const p of prefs) {
    const v = voices.find((v) => p.test(v.lang) && !/male/i.test(v.name));
    if (v) return v;
  }
  return voices[0] ?? null;
}

function splitSentences(text: string): string[] {
  // Keep each utterance short — Chrome stalls on ~15s+ utterances.
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface SpeakHandle {
  /** Resolves when all chunks finished (or were cancelled). */
  done: Promise<void>;
  cancel(): void;
  /** Timestamp (ms) when the FIRST chunk actually started speaking — the latency anchor. */
  firstSyllableAt: Promise<number>;
  /** Engine that ACTUALLY produced this utterance's audio (after runtime
   * fallbacks) — lets the hook flag latencies polluted by a fallback. */
  engineUsed: Promise<VoiceEngine>;
}

/** Chatterbox voices are wav filenames — never forward those to kokoro. */
function kokoroVoice(voice?: string): string {
  return voice && !voice.endsWith(".wav") ? voice : PRIYA_VOICE;
}

function wrapKokoro(h: KokoroHandle): SpeakHandle {
  const engineUsed = h.firstSyllableAt.then<VoiceEngine>(() => {
    lastEngine = "kokoro";
    return "kokoro";
  });
  return { done: h.done, cancel: () => h.cancel(), firstSyllableAt: h.firstSyllableAt, engineUsed };
}

function serverSpeak(text: string, engine: "elevenlabs" | "chatterbox", voice?: string): SpeakHandle {
  let cancelled = false;
  const abort = new AbortController();
  const sources: AudioBufferSourceNode[] = [];
  let fellBack: SpeakHandle | null = null;

  let resolveFirst!: (t: number) => void;
  const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));
  let resolveEngine!: (e: VoiceEngine) => void;
  const engineUsed = new Promise<VoiceEngine>((r) => (resolveEngine = r));
  const markSpoke = (e: VoiceEngine) => {
    lastEngine = e;
    resolveEngine(e);
  };

  const postTts = (stream: boolean) =>
    fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, engine, voice, stream }),
      signal: abort.signal,
    });

  const playBuffered = async (res: Response) => {
    const buf = await res.arrayBuffer();
    if (cancelled) return;
    const c = sharedCtx();
    const audio = await c.decodeAudioData(buf);
    if (cancelled) return;
    await new Promise<void>((resolve) => {
      const src = c.createBufferSource();
      src.buffer = audio;
      tapPlayback(c, src); // orb rides the real playback amplitude
      src.onended = () => resolve();
      sources.push(src);
      resolveFirst(Date.now());
      markSpoke(engine);
      src.start();
    });
  };

  // Read the streamed WAV body and schedule gapless PCM chunks on the shared
  // context — the first chunk plays while the server still synthesizes the
  // rest. Returns false when the caller should retry the buffered path.
  const playStreaming = async (body: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<boolean> => {
    const reader = body.getReader();
    const c = sharedCtx();
    let header: ReturnType<typeof parseWavHeader> = null;
    let pending = new Uint8Array(0);
    let scheduledUntil = 0;
    let started = false;
    let created = 0;
    let endedCount = 0;
    let onAllEnded: (() => void) | null = null;

    for (;;) {
      let eof = false;
      let value: Uint8Array<ArrayBuffer> | undefined;
      try {
        ({ done: eof, value } = await reader.read());
      } catch {
        if (!started) return false; // died before any audio — buffered retry
        break; // died mid-play: keep what is already scheduled
      }
      if (cancelled) {
        void reader.cancel().catch(() => {});
        return true;
      }
      if (value?.length) pending = concatBytes(pending, value);
      if (!header) {
        try {
          header = parseWavHeader(pending);
        } catch {
          void reader.cancel().catch(() => {});
          return false; // not a WAV we can stream
        }
        if (header) {
          if (header.numChannels !== 1 || header.bitsPerSample !== 16) {
            void reader.cancel().catch(() => {});
            return false; // exotic format — let decodeAudioData handle it
          }
          pending = pending.slice(header.dataOffset);
        } else if (eof) {
          return false; // stream ended mid-header
        }
      }
      if (header) {
        const { samples, remainder } = pcm16ToFloat32(pending);
        pending = remainder;
        if (samples.length) {
          const buf = c.createBuffer(1, samples.length, header.sampleRate);
          buf.copyToChannel(samples, 0);
          const src = c.createBufferSource();
          src.buffer = buf;
          tapPlayback(c, src);
          created++;
          src.onended = () => {
            endedCount++;
            if (onAllEnded && endedCount >= created) onAllEnded();
          };
          const startAt = nextChunkStartTime(c.currentTime, scheduledUntil);
          scheduledUntil = startAt + buf.duration;
          sources.push(src);
          src.start(startAt);
          if (!started) {
            started = true;
            resolveFirst(Date.now() + Math.round((startAt - c.currentTime) * 1000));
            markSpoke(engine);
          }
        }
      }
      if (eof) break;
    }
    if (!started) return false; // header but zero samples — buffered retry
    if (endedCount < created) {
      await new Promise<void>((resolve) => {
        onAllEnded = resolve;
        if (endedCount >= created) resolve();
      });
    }
    return true;
  };

  const done = (async () => {
    try {
      const wantStream = engine === "chatterbox";
      const res = await postTts(wantStream);
      if (!res.ok) throw new Error(`tts_${res.status}`);
      if (wantStream && res.body) {
        if (await playStreaming(res.body)) return;
        if (cancelled) return;
        // Streaming unusable (bad header / died early): buffered, SAME engine.
        const retry = await postTts(false);
        if (!retry.ok) throw new Error(`tts_${retry.status}`);
        await playBuffered(retry);
        return;
      }
      await playBuffered(res);
    } catch {
      // Request failed → next engine. Latency honesty: the fallback's REAL
      // first syllable resolves firstSyllableAt (a failed fetch's own timing
      // never does), and engineUsed reports who actually spoke.
      if (!cancelled) {
        fellBack =
          engine === "chatterbox" && kokoroStatus() === "ready"
            ? wrapKokoro(kokoroSpeak(splitSentences(text), kokoroVoice(voice)))
            : systemSpeak(text, undefined);
        fellBack.firstSyllableAt.then(resolveFirst);
        fellBack.engineUsed.then(resolveEngine);
        await fellBack.done;
      }
    } finally {
      // Cancelled/empty paths must not hang awaiters (no-ops once resolved).
      resolveFirst(Date.now());
      resolveEngine(engine);
    }
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      abort.abort();
      for (const s of sources) {
        try {
          s.stop();
        } catch {}
      }
      fellBack?.cancel();
    },
    firstSyllableAt,
    engineUsed,
  };
}

export function speak(
  text: string,
  opts?: { rate?: number; voice?: string; hue?: [number, number, number] },
): SpeakHandle {
  setAiHue(opts?.hue ?? null); // per-utterance orb tint (GD personas); null = default family
  const engine = getVoiceEngine();
  if (engine === "elevenlabs" || engine === "chatterbox") return serverSpeak(text, engine, opts?.voice);
  // Premium on-device path: only when the user opted in AND the model finished
  // loading — never make the interview wait on a model download.
  if (engine === "kokoro") {
    if (kokoroStatus() === "ready") {
      return wrapKokoro(kokoroSpeak(splitSentences(text), kokoroVoice(opts?.voice)));
    }
    ensureKokoroLoading(); // keep warming; system voice covers this utterance
  }
  return systemSpeak(text, opts);
}

/** Voice pipelining (streamed turns): the first sentence is already speaking;
 * chain the remainder as a second utterance under ONE composite handle.
 * cancel() covers BOTH utterances (barge-in/cleanup must kill the chained tail
 * too); firstSyllableAt/engineUsed are the FIRST utterance's — the latency
 * anchor stays the first audible syllable. Additive: nothing existing changes. */
export function chainSpeak(
  first: SpeakHandle,
  remainderText: string,
  opts?: { rate?: number; voice?: string; hue?: [number, number, number] },
): SpeakHandle {
  let cancelled = false;
  let second: SpeakHandle | null = null;
  const done = (async () => {
    await first.done;
    if (cancelled || !remainderText) return;
    second = speak(remainderText, opts);
    await second.done;
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      first.cancel();
      second?.cancel();
    },
    firstSyllableAt: first.firstSyllableAt,
    engineUsed: first.engineUsed,
  };
}

export interface PreparedSpeech {
  /** Resolves once the audio is fetched + decoded — or once preparation gave
   * up (play() transparently falls back either way). Never rejects. */
  ready: Promise<void>;
  /** Schedule the prepared audio NOW (firstSyllableAt ≈ now) and return a
   * normal SpeakHandle. If preparation failed, was cancelled, or hasn't
   * finished, this routes through live speak() — callers never branch. */
  play(): SpeakHandle;
  /** Abort the fetch, free the decoded buffer, stop anything already playing. */
  cancel(): void;
}

/** Ahead-of-time TTS: fetch + decode the full utterance on the SHARED
 * AudioContext before it is needed, so play() starts with zero synthesis
 * latency. Buffered rather than streamed on purpose — preparation runs while
 * the candidate is still talking, so time-to-first-chunk is irrelevant and a
 * single decoded buffer schedules instantly. The engine fallback chain is NOT
 * duplicated here: any failure simply routes play() through normal speak(). */
export function prepareSpeak(
  text: string,
  opts?: { voice?: string; rate?: number; hue?: [number, number, number] },
): PreparedSpeech {
  const engine = getVoiceEngine();
  const abort = new AbortController();
  let cancelled = false;
  let buffer: AudioBuffer | null = null;
  let started: AudioBufferSourceNode | null = null;

  const ready: Promise<void> =
    engine === "chatterbox" || engine === "elevenlabs"
      ? (async () => {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              engine,
              ...(opts?.voice ? { voice: opts.voice } : {}),
              stream: false,
            }),
            signal: abort.signal,
          });
          if (!res.ok) throw new Error(`tts_${res.status}`);
          const bytes = await res.arrayBuffer();
          if (cancelled) return;
          buffer = await sharedCtx().decodeAudioData(bytes);
        })().catch(() => {
          buffer = null; // failed/aborted preparation is silent — play() goes live
        })
      : Promise.resolve(); // kokoro/system have no server bytes to pre-fetch

  return {
    ready,
    play(): SpeakHandle {
      const audio = buffer;
      if (!audio || cancelled) {
        // Live fallback: abort the still-pending prepare fetch so two
        // syntheses of the same utterance never run concurrently.
        abort.abort();
        return speak(text, opts); // transparent live fallback
      }
      buffer = null; // consumed — a second play() routes live instead of double-scheduling
      setAiHue(opts?.hue ?? null); // mirror speak(): per-utterance orb tint
      const c = sharedCtx();
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => (resolveDone = r));
      const src = c.createBufferSource();
      src.buffer = audio;
      tapPlayback(c, src); // orb rides the real playback amplitude
      src.onended = () => resolveDone();
      started = src;
      lastEngine = engine;
      src.start();
      return {
        done,
        cancel() {
          try {
            src.stop();
          } catch {}
        },
        firstSyllableAt: Promise.resolve(Date.now()),
        engineUsed: Promise.resolve(engine),
      };
    },
    cancel() {
      cancelled = true;
      buffer = null;
      abort.abort();
      try {
        started?.stop();
      } catch {}
    },
  };
}

function systemSpeak(text: string, opts?: { rate?: number }): SpeakHandle {
  if (!ttsSupported()) {
    return {
      done: Promise.resolve(),
      cancel() {},
      firstSyllableAt: Promise.resolve(Date.now()),
      engineUsed: Promise.resolve("system"),
    };
  }
  let cancelled = false;
  let resolveFirst!: (t: number) => void;
  const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));
  const engineUsed = firstSyllableAt.then<VoiceEngine>(() => {
    lastEngine = "system";
    return "system";
  });

  const done = (async () => {
    const voices = await loadVoices();
    const voice = pickVoice(voices);
    const chunks = splitSentences(text);
    let first = true;
    for (const chunk of chunks) {
      if (cancelled) break;
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(chunk);
        if (voice) u.voice = voice;
        u.rate = opts?.rate ?? 1.0;
        u.onstart = () => {
          if (first) {
            first = false;
            resolveFirst(Date.now());
            startPseudoTalking(); // no audio graph on speechSynthesis — shaped envelope
          }
        };
        u.onend = () => resolve();
        u.onerror = () => resolve(); // an errored chunk must not hang the interview
        window.speechSynthesis.speak(u);
      });
    }
    stopPseudoTalking();
    if (first) resolveFirst(Date.now()); // nothing spoke (cancelled/empty) — don't hang awaiters
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      stopPseudoTalking();
      window.speechSynthesis.cancel();
    },
    firstSyllableAt,
    engineUsed,
  };
}
