"use client";

// Verbal acknowledgments ("Hmm.", "Mm-hm.") — the latency mask between the
// candidate's last word and the interviewer's reply, plus the conversational
// nudges ("go on?", the rephrase offer). The rule after user feedback: an ack
// must sound like THE SAME VOICE as the interviewer or not happen at all. So:
// - chatterbox / elevenlabs: acks are pre-generated ONCE per (voice, kind)
//   through the same engine and cached as decoded audio — playback is instant
//   and indistinguishable from the interviewer's own mannerisms. The cache is
//   keyed by voice so GD personas and the two interviewer personas never share
//   buffers.
// - system voice / kokoro-not-ready: NO ack. The robotic "ehh-yamm" was worse
//   than silence; the orb's thinking state carries the gap instead.

import { tapPlayback } from "@/lib/audio-viz";
import { getVoiceEngine } from "@/lib/tts";

export type AckKind = "ack" | "encourage" | "rephrase";

// The "ack" lines are the latency mask: a real interviewer thinks out loud for
// a couple of seconds before the next question. These are pre-synthesized once
// and play INSTANTLY when the answer ends, bridging the ~3s the studio voice needs to
// synthesize the real reply on a GPU-less machine — so there is never dead air
// between the candidate finishing and the interviewer speaking. Kept varied so
// five of them across one round don't sound like a loop.
export const ACK_TEXTS: Record<AckKind, string[]> = {
  ack: [
    "Mm, okay. Let me think about that for a second.",
    "Right, got it. Give me just a moment on that.",
    "Okay, that's helpful — let me follow up on that.",
    "I see. Let me take that in for a second.",
  ],
  encourage: ["Mm-hm — go on?", "Take your time.", "Sure, keep going."],
  rephrase: ["No rush at all. Want me to rephrase the question?"],
};

const ACK_KINDS = Object.keys(ACK_TEXTS) as AckKind[];

// Cache key: `${voice ?? "default"}:${kind}` — per-voice so personas never
// hear each other's mannerisms.
const cache = new Map<string, { buffers: AudioBuffer[]; texts: string[] }>();
const preparedVoices = new Set<string>();
const preparingVoices = new Set<string>();
const counters = new Map<string, number>();
let ctx: AudioContext | null = null;
// playAck has no voice in the pinned signature — it plays the voice most
// recently passed to prepareAcks (the round's interviewer).
let activeVoiceKey = "default";

/** Fire-and-forget at interview start; failures just mean silent thinking. */
export async function prepareAcks(voice?: string): Promise<void> {
  const engine = getVoiceEngine();
  const key = voice ?? "default";
  activeVoiceKey = key;
  if (preparedVoices.has(key) || preparingVoices.has(key)) return;
  if (engine !== "chatterbox" && engine !== "elevenlabs") {
    preparedVoices.add(key);
    return;
  }
  preparingVoices.add(key);
  try {
    ctx = ctx ?? new AudioContext();
    for (const kind of ACK_KINDS) {
      const buffers: AudioBuffer[] = [];
      const texts: string[] = [];
      for (const text of ACK_TEXTS[kind]) {
        try {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, engine, ...(voice ? { voice } : {}) }),
          });
          if (!res.ok) continue;
          buffers.push(await ctx.decodeAudioData(await res.arrayBuffer()));
          texts.push(text);
        } catch {
          // one failed ack is no ack — never block the interview on this
        }
      }
      cache.set(`${key}:${kind}`, { buffers, texts });
    }
    preparedVoices.add(key);
  } finally {
    preparingVoices.delete(key);
  }
}

/** Reset between interviews so a changed engine/voice re-prepares. */
export function resetAcks(): void {
  cache.clear();
  preparedVoices.clear();
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
  if (engine !== "chatterbox" && engine !== "elevenlabs") return null;
  const key = `${voice ?? activeVoiceKey}:${kind}`;
  const entry = cache.get(key);
  if (!entry || entry.buffers.length === 0 || !ctx) return null;
  const n = counters.get(key) ?? 0;
  counters.set(key, n + 1);
  const buf = entry.buffers[n % entry.buffers.length];
  const text = entry.texts[n % entry.texts.length];
  let src: AudioBufferSourceNode | null = null;
  const done = new Promise<void>((resolve) => {
    src = ctx!.createBufferSource();
    src.buffer = buf;
    tapPlayback(ctx!, src);
    src.onended = () => resolve();
    src.start();
  });
  return {
    done,
    cancel() {
      try {
        src?.stop();
      } catch {}
    },
    firstSyllableAt: Promise.resolve(Date.now()),
    text,
  };
}
