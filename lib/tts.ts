"use client";

// TTS with two engines behind one interface:
// - system (speechSynthesis): instant, robotic; the three Chrome traps handled
//   (voices race, long-utterance stall, background-tab pause).
// - kokoro (on-device neural): premium voices, takes over once its model is
//   downloaded; system speaks in the meantime. Selected via the setup toggle.

import { ensureKokoroLoading, kokoroSpeak, kokoroStatus, PRIYA_VOICE } from "@/lib/tts-kokoro";

const ENGINE_KEY = "pds_voice_engine";

export type VoiceEngine = "system" | "kokoro" | "elevenlabs";

export function getVoiceEngine(): VoiceEngine {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(ENGINE_KEY);
    return v === "kokoro" || v === "elevenlabs" ? v : "system";
  } catch {
    return "system";
  }
}

export function setVoiceEngine(engine: VoiceEngine): void {
  try {
    window.localStorage.setItem(ENGINE_KEY, engine);
  } catch {}
  if (engine === "kokoro") ensureKokoroLoading();
}

export { kokoroStatus, ensureKokoroLoading };

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
}

function elevenLabsSpeak(text: string): SpeakHandle {
  let cancelled = false;
  let source: AudioBufferSourceNode | null = null;
  const abort = new AbortController();
  let resolveFirst!: (t: number) => void;
  const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));
  let fellBack: SpeakHandle | null = null;

  const done = (async () => {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`tts_${res.status}`);
      const buf = await res.arrayBuffer();
      if (cancelled) return;
      const ctx = new AudioContext();
      const audio = await ctx.decodeAudioData(buf);
      if (cancelled) return;
      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = audio;
        src.connect(ctx.destination);
        src.onended = () => resolve();
        source = src;
        resolveFirst(Date.now());
        src.start();
      });
    } catch {
      // Any failure (no key, quota, network): system voice covers the line —
      // the interview never goes silent.
      if (!cancelled) {
        fellBack = systemSpeak(text, undefined);
        fellBack.firstSyllableAt.then(resolveFirst);
        await fellBack.done;
      }
    } finally {
      resolveFirst(Date.now()); // never leave awaiters hanging
    }
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      abort.abort();
      try {
        source?.stop();
      } catch {}
      fellBack?.cancel();
    },
    firstSyllableAt,
  };
}

export function speak(text: string, opts?: { rate?: number; voice?: string }): SpeakHandle {
  const engine = getVoiceEngine();
  if (engine === "elevenlabs") return elevenLabsSpeak(text);
  // Premium on-device path: only when the user opted in AND the model finished
  // loading — never make the interview wait on a model download.
  if (engine === "kokoro") {
    if (kokoroStatus() === "ready") {
      return kokoroSpeak(splitSentences(text), opts?.voice ?? PRIYA_VOICE);
    }
    ensureKokoroLoading(); // keep warming; system voice covers this utterance
  }
  return systemSpeak(text, opts);
}

function systemSpeak(text: string, opts?: { rate?: number }): SpeakHandle {
  if (!ttsSupported()) {
    return { done: Promise.resolve(), cancel() {}, firstSyllableAt: Promise.resolve(Date.now()) };
  }
  let cancelled = false;
  let resolveFirst!: (t: number) => void;
  const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));

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
          }
        };
        u.onend = () => resolve();
        u.onerror = () => resolve(); // an errored chunk must not hang the interview
        window.speechSynthesis.speak(u);
      });
    }
    if (first) resolveFirst(Date.now()); // nothing spoke (cancelled/empty) — don't hang awaiters
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      window.speechSynthesis.cancel();
    },
    firstSyllableAt,
  };
}
