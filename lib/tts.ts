"use client";

// speechSynthesis wrapper with the three traps the plan names handled:
// 1. getVoices() is empty on first call (async load race) → wait for voiceschanged.
// 2. Long utterances stall Chrome → sentence-chunked utterance queue.
// 3. Background tabs pause TTS → surfaced by the room's "keep tab active" notice.

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

export function speak(text: string, opts?: { rate?: number }): SpeakHandle {
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
