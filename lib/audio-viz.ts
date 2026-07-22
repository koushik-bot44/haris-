"use client";

// Shared visualization bus for the voice orb. Every audio path in the app
// feeds a 0..1 level here; the orb reads it each animation frame without
// touching React state (no re-renders at 60fps).
//
// Sources, in order of realness:
// - user mic: a dedicated AnalyserNode on getUserMedia (true amplitude)
// - kokoro / chatterbox / elevenlabs playback: AnalyserNode tapped into their
//   AudioContext graph (true amplitude)
// - speechSynthesis: no audio graph access — a shaped pseudo-envelope while
//   speaking (documented approximation)

export type VizMode = "idle" | "user" | "ai" | "thinking";

interface VizState {
  mode: VizMode;
  level: number; // 0..1, smoothed by the writer
  pseudo: boolean; // true while a pseudo-envelope drives level
}

const state: VizState = { mode: "idle", level: 0, pseudo: false };

export function vizState(): Readonly<VizState> {
  return state;
}

export function setVizMode(mode: VizMode): void {
  state.mode = mode;
  if (mode === "idle" || mode === "thinking") state.level = 0;
}

// ——— user mic (true amplitude) ———

let micStream: MediaStream | null = null;
let micRaf = 0;

export async function startMicViz(): Promise<void> {
  if (typeof window === "undefined" || micStream) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    return; // no permission — the orb still animates from STT activity pseudo
  }
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(micStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (buf.length / 4));
    if (state.mode === "user") {
      // Perceptual boost: quiet speech should still visibly move the orb.
      state.level = Math.min(1, state.level * 0.6 + Math.min(1, rms * 6) * 0.4);
    }
    micRaf = requestAnimationFrame(tick);
  };
  micRaf = requestAnimationFrame(tick);
}

export function stopMicViz(): void {
  cancelAnimationFrame(micRaf);
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
}

// ——— playback taps (true amplitude for AudioContext-based engines) ———

/** Insert an analyser between `node` and the destination; feeds the orb while
 * mode is "ai". Returns the node to connect INSTEAD of ctx.destination. */
export function tapPlayback(ctx: AudioContext, node: AudioNode): AudioNode {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  node.connect(analyser);
  analyser.connect(ctx.destination);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    if (ctx.state === "closed") return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (buf.length / 4));
    if (state.mode === "ai" && !state.pseudo) {
      state.level = Math.min(1, state.level * 0.55 + Math.min(1, rms * 7) * 0.45);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return analyser;
}

// ——— pseudo-envelope (speechSynthesis has no audio graph) ———

let pseudoRaf = 0;

export function startPseudoTalking(): void {
  state.pseudo = true;
  const t0 = performance.now();
  const tick = (t: number) => {
    if (!state.pseudo) return;
    if (state.mode === "ai") {
      const s = (t - t0) / 1000;
      // Speech-shaped chatter: two detuned oscillations + slow breath.
      const env =
        0.45 +
        0.25 * Math.sin(s * 7.3) * Math.sin(s * 2.1) +
        0.18 * Math.sin(s * 13.7 + 1.2) +
        0.12 * Math.sin(s * 0.9);
      state.level = Math.max(0.08, Math.min(1, env));
    }
    pseudoRaf = requestAnimationFrame(tick);
  };
  pseudoRaf = requestAnimationFrame(tick);
}

export function stopPseudoTalking(): void {
  state.pseudo = false;
  cancelAnimationFrame(pseudoRaf);
}
