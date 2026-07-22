"use client";

// Verbal acknowledgments ("Hmm.", "Mm-hm.") — the latency mask between the
// candidate's last word and the interviewer's reply. The rule after user
// feedback: an ack must sound like THE SAME VOICE as the interviewer or not
// happen at all. So:
// - chatterbox / elevenlabs: acks are pre-generated ONCE per session through
//   the same engine and cached as decoded audio — playback is instant and
//   indistinguishable from the interviewer's own mannerisms.
// - system voice / kokoro-not-ready: NO ack. The robotic "ehh-yamm" was worse
//   than silence; the orb's thinking state carries the gap instead.

import { tapPlayback } from "@/lib/audio-viz";
import { getVoiceEngine } from "@/lib/tts";

const ACK_TEXTS = ["Hmm.", "Mm-hm, okay.", "Right."];

let buffers: AudioBuffer[] = [];
let ctx: AudioContext | null = null;
let prepared = false;
let preparing = false;
let ackCounter = 0;

/** Fire-and-forget at interview start; failures just mean silent thinking. */
export async function prepareAcks(): Promise<void> {
  const engine = getVoiceEngine();
  if (preparing || prepared) return;
  if (engine !== "chatterbox" && engine !== "elevenlabs") {
    prepared = true;
    return;
  }
  preparing = true;
  try {
    ctx = ctx ?? new AudioContext();
    const out: AudioBuffer[] = [];
    for (const text of ACK_TEXTS) {
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, engine }),
        });
        if (!res.ok) continue;
        out.push(await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch {
        // one failed ack is no ack — never block the interview on this
      }
    }
    buffers = out;
  } finally {
    prepared = true;
    preparing = false;
  }
}

/** Reset between interviews so a changed engine re-prepares. */
export function resetAcks(): void {
  buffers = [];
  prepared = false;
  ackCounter = 0;
}

export interface AckHandle {
  done: Promise<void>;
  cancel(): void;
  firstSyllableAt: Promise<number>;
}

export function playAck(): AckHandle | null {
  const engine = getVoiceEngine();
  if (engine !== "chatterbox" && engine !== "elevenlabs") return null;
  if (buffers.length === 0 || !ctx) return null;
  const buf = buffers[ackCounter++ % buffers.length];
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
  };
}
