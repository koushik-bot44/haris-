"use client";

// Verbal acknowledgments ("Hmm.", "Mm-hm.") — the latency mask between the
// candidate's last word and the interviewer's reply, plus the conversational
// nudges ("go on?", the rephrase offer). The rule after user feedback: an ack
// must sound like THE SAME VOICE as the interviewer or not happen at all. So:
// - cloud / chatterbox: acks are pre-generated ONCE per (voice, kind) through
//   the same engine and cached as ready-to-play audio — playback is instant and
//   indistinguishable from the interviewer's own mannerisms. The cache is
//   keyed by voice so GD personas and the two interviewer personas never share
//   clips.
// - system voice / kokoro-not-ready: NO cached ack. The room speaks nudges
//   through the normal voice instead; the pure "ack" mask is skipped (the
//   orb's thinking state carries the gap).
//
// WHY BLOB URLS AND NOT WEB AUDIO.
//
// This module used to decode each clip with its own `new AudioContext()`. Three
// AudioContexts then existed in one tab — lib/tts.ts (all server-voice
// playback), lib/tts-kokoro.ts (the on-device voice) and this one — and Chrome
// caps how many a page may hold before `new AudioContext()` starts throwing.
// The one that must survive is tts.ts's: it is where the interviewer's actual
// voice is scheduled. An ack is a one-second pre-rendered clip that needs
// nothing from an audio graph, so it plays through an <audio> element off a
// blob URL instead. Same bytes, same voice, same "generate once, replay from
// memory forever" property (a blob URL is local), one fewer context.
//
// The only thing given up is the orb riding the ack's true amplitude — which is
// exactly what the header above already says the ack does not need, because the
// orb is in its thinking state for the whole latency mask.

import { getVoiceEngine, isServerVoiceEngine } from "@/lib/tts";

export type AckKind = "ack" | "encourage" | "rephrase";

// Kept SHORT and FEW on purpose: each line is pre-synthesized through the
// voice server at mic-check, and long/many lines saturate a local one.
export const ACK_TEXTS: Record<AckKind, string[]> = {
  ack: ["Mm, okay.", "Right, let me think.", "Got it, one moment."],
  encourage: ["Mm-hm — go on?"],
  rephrase: ["Want me to rephrase that?"],
};

const ACK_KINDS = Object.keys(ACK_TEXTS) as AckKind[];

/** Fallback watchdog before metadata says how long the clip is. Acks are one
 * short sentence; this only ever fires when playback never started at all. */
const ACK_GUARD_MS = 5000;

// Cache key: `${voice ?? "default"}:${kind}` — per-voice so personas never
// hear each other's mannerisms.
const cache = new Map<string, { urls: string[]; texts: string[] }>();
const preparedVoices = new Set<string>();
const preparingVoices = new Set<string>();
const counters = new Map<string, number>();
/** Every object URL this module minted, so resetAcks can hand the memory back. */
const minted = new Set<string>();
// playAck has no voice in the pinned signature — it plays the voice most
// recently passed to prepareAcks (the round's interviewer).
let activeVoiceKey = "default";
/** Bumped by resetAcks(): an in-flight prepareAcks from a previous interview
 * must not write its (possibly wrong-engine) buffers into the fresh cache. */
let generation = 0;

function mint(blob: Blob): string | null {
  try {
    const url = URL.createObjectURL(blob);
    minted.add(url);
    return url;
  } catch {
    return null; // no URL.createObjectURL (SSR / exotic host) — no ack, no crash
  }
}

/** Fire-and-forget at interview start; failures just mean silent thinking. */
export async function prepareAcks(voice?: string): Promise<void> {
  const engine = getVoiceEngine();
  const key = voice ?? "default";
  activeVoiceKey = key;
  if (preparedVoices.has(key) || preparingVoices.has(key)) return;
  if (!isServerVoiceEngine(engine)) {
    preparedVoices.add(key);
    return;
  }
  const serverEngine = engine === "chatterbox" ? "chatterbox" : "cloud";
  const gen = generation;
  preparingVoices.add(key);
  try {
    for (const kind of ACK_KINDS) {
      const urls: string[] = [];
      const texts: string[] = [];
      for (const text of ACK_TEXTS[kind]) {
        try {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            // Buffered (stream:false) on purpose: acks are fetched once and
            // replayed from memory, so one finite WAV is exactly what is wanted.
            body: JSON.stringify({ text, engine: serverEngine, ...(voice ? { voice } : {}), stream: false }),
          });
          if (gen !== generation) return; // reset while we were away — discard
          if (!res.ok) continue;
          const url = mint(await res.blob());
          if (gen !== generation) return;
          if (!url) continue;
          urls.push(url);
          texts.push(text);
        } catch {
          // one failed ack is no ack — never block the interview on this
        }
      }
      if (gen !== generation) return;
      cache.set(`${key}:${kind}`, { urls, texts });
    }
    if (gen === generation) preparedVoices.add(key);
  } finally {
    preparingVoices.delete(key);
  }
}

/** Reset between interviews so a changed engine/voice re-prepares. */
export function resetAcks(): void {
  generation++;
  for (const url of minted) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
  minted.clear();
  cache.clear();
  preparedVoices.clear();
  preparingVoices.clear();
  counters.clear();
  activeVoiceKey = "default";
}

export interface AckHandle {
  done: Promise<void>;
  cancel(): void;
  firstSyllableAt: Promise<number>;
  /** The line being spoken — callers caption it (captions are a11y). */
  text: string;
}

export function playAck(kind: AckKind = "ack", voice?: string): AckHandle | null {
  const engine = getVoiceEngine();
  if (!isServerVoiceEngine(engine)) return null;
  const key = `${voice ?? activeVoiceKey}:${kind}`;
  const entry = cache.get(key);
  if (!entry || entry.urls.length === 0) return null;
  if (typeof Audio === "undefined") return null;
  const n = counters.get(key) ?? 0;
  counters.set(key, n + 1);
  const url = entry.urls[n % entry.urls.length];
  const text = entry.texts[n % entry.texts.length];

  const el = new Audio(url);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    let settled = false;
    // Watchdog: an element that is never allowed to start (autoplay policy, a
    // decode failure) fires no `ended`, and the room must not wait on it. Once
    // metadata lands, the real duration replaces the blunt default.
    let guard = setTimeout(() => finish(), ACK_GUARD_MS);
    finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve();
    };
    el.onloadedmetadata = () => {
      if (settled || !Number.isFinite(el.duration) || el.duration <= 0) return;
      clearTimeout(guard);
      guard = setTimeout(() => finish(), el.duration * 1000 + 1000);
    };
    el.onended = () => finish();
    el.onerror = () => finish();
    try {
      // Not every host returns the promise (older Safari, test doubles).
      const started = el.play() as Promise<void> | undefined;
      if (started && typeof started.catch === "function") void started.catch(() => finish());
    } catch {
      finish();
    }
  });

  return {
    done,
    cancel() {
      try {
        el.pause();
      } catch {}
      finish(); // a cancelled ack must resolve, or the caller waits out the guard
    },
    firstSyllableAt: Promise.resolve(Date.now()),
    text,
  };
}
