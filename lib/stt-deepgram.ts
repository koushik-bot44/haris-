"use client";

// Deepgram live STT — true streaming recognition with interim results in
// ANY browser: the closest thing to how Gemini Live / ChatGPT Voice hear you.
// The browser never sees the API key: /api/stt/token mints a short-lived JWT
// (server-side, from DEEPGRAM_API_KEY), the socket opens with it, and raw
// 16 kHz PCM16 frames stream up while Results/SpeechStarted events flow into
// the same reducer as Chrome's recognizer. If the socket cannot be opened, the
// session falls back to the injected engine (Chrome/cloud) transparently.

import { initialSttState, sttReduce, type SttState } from "@/lib/stt-reducer";
import type { SttSession } from "@/lib/stt";
import { downsample, STT_TARGET_RATE } from "@/lib/stt-segmented";
import { float32ToPcm16 } from "@/lib/pcm-wav";

const KEEPALIVE_MS = 5_000;
const OPEN_TIMEOUT_MS = 6_000;

interface DgResults {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}
interface DgEvent {
  type: string;
}

function listenUrl(token: string, sampleRate: number): string {
  const q = new URLSearchParams({
    model: "nova-3",
    language: "en",
    encoding: "linear16",
    sample_rate: String(sampleRate),
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: "300",
    utterance_end_ms: "1200",
    vad_events: "true",
    access_token: token,
  });
  return `wss://api.deepgram.com/v1/listen?${q.toString()}`;
}

export function startDeepgramStt(
  callbacks: { onUpdate: (state: SttState) => void; onDegrade: (reason: string) => void },
  fallback: (() => SttSession | null) | null,
): SttSession {
  let state = initialSttState();
  let stopped = false;
  let inner: SttSession | null = null; // set when we fell back to another engine
  let ws: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let opened = false;
  let closeResolve: (() => void) | null = null;

  const dispatch = (action: Parameters<typeof sttReduce>[1]) => {
    const out = sttReduce(state, action);
    state = out.state;
    callbacks.onUpdate(state);
    if (out.effect?.kind === "degrade_to_text") {
      teardown();
      callbacks.onDegrade(out.effect.reason);
    }
  };

  const teardown = () => {
    stopped = true;
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    try {
      processor?.disconnect();
    } catch {}
    try {
      void ctx?.close();
    } catch {}
    stream?.getTracks().forEach((t) => t.stop());
    try {
      ws?.close();
    } catch {}
  };

  const useFallback = (reason: string) => {
    if (stopped) return;
    teardown();
    stopped = false;
    if (fallback) {
      console.warn(`[stt] deepgram live unavailable (${reason}) — falling back`);
      inner = fallback();
      if (inner) return;
    }
    stopped = true;
    callbacks.onDegrade(reason);
  };

  const connect = (token: string, sampleRate: number, useSubprotocol: boolean): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const url = listenUrl(token, sampleRate);
      // Deepgram accepts a temporary JWT as `access_token` in the query; the
      // subprotocol form is the retry for proxies that strip query params.
      const sock = useSubprotocol ? new WebSocket(url, ["bearer", token]) : new WebSocket(url);
      sock.binaryType = "arraybuffer";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          sock.close();
        } catch {}
        reject(new Error("open_timeout"));
      }, OPEN_TIMEOUT_MS);
      sock.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(sock);
      };
      sock.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("open_failed"));
      };
      sock.onclose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("closed_before_open"));
      };
    });

  (async () => {
    let token: string;
    try {
      const res = await fetch("/api/stt/token", { method: "POST" });
      if (!res.ok) throw new Error(`token_${res.status}`);
      const d = (await res.json()) as { token?: string };
      if (!d.token) throw new Error("token_missing");
      token = d.token;
    } catch (err) {
      useFallback(err instanceof Error ? err.message : "token_failed");
      return;
    }
    if (stopped) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      stopped = true;
      callbacks.onDegrade("not-allowed");
      return;
    }
    if (stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    try {
      ws = await connect(token, STT_TARGET_RATE, false).catch(() => connect(token, STT_TARGET_RATE, true));
    } catch (err) {
      useFallback(err instanceof Error ? err.message : "connect_failed");
      return;
    }
    if (stopped) {
      teardown();
      return;
    }
    opened = true;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let msg: DgEvent;
      try {
        msg = JSON.parse(e.data) as DgEvent;
      } catch {
        return;
      }
      const t = Date.now();
      if (msg.type === "Results") {
        const r = msg as DgResults;
        const text = r.channel?.alternatives?.[0]?.transcript ?? "";
        if (!text.trim() && !r.is_final) return;
        if (text.trim()) dispatch({ type: "RESULT", t, text, isFinal: Boolean(r.is_final) });
        else if (r.is_final && state.interim) dispatch({ type: "RESULT", t, text: state.interim, isFinal: true });
      } else if (msg.type === "SpeechStarted") {
        dispatch({ type: "SPEECH_ACTIVITY", t });
      }
    };
    ws.onerror = () => {
      if (stopped) return;
      dispatch({ type: "ERROR", t: Date.now(), error: "network" });
    };
    ws.onclose = () => {
      closeResolve?.();
      closeResolve = null;
      if (stopped) return;
      // The service closed on us mid-answer: count it as a network error and
      // let the reducer's budget decide (two in a row degrade to text).
      dispatch({ type: "ERROR", t: Date.now(), error: "network" });
      dispatch({ type: "ENGINE_END", t: Date.now() });
      // No auto-restart of a socket here; the next listening window reconnects.
    };
    keepalive = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, KEEPALIVE_MS);

    ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);
    const inRate = ctx.sampleRate;
    dispatch({ type: "START", t: Date.now() });
    processor.onaudioprocess = (e) => {
      if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
      const pcm = float32ToPcm16(downsample(e.inputBuffer.getChannelData(0), inRate));
      ws.send(pcm.buffer);
    };
  })();

  const finalizeAndClose = (): Promise<void> => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve) => {
      closeResolve = resolve;
      try {
        ws!.send(JSON.stringify({ type: "Finalize" }));
        ws!.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        resolve();
      }
    });
  };

  return {
    stop() {
      if (inner) return inner.stop();
      dispatch({ type: "STOP", t: Date.now() });
      void finalizeAndClose();
      teardown();
      return state;
    },
    async stopAndSettle(settleMs = 1500) {
      if (inner) return inner.stopAndSettle(settleMs);
      dispatch({ type: "STOP", t: Date.now() });
      // Stop the mic, but keep the socket open long enough for the final
      // transcript to arrive after Finalize/CloseStream.
      try {
        processor?.disconnect();
      } catch {}
      stream?.getTracks().forEach((t) => t.stop());
      if (opened) await Promise.race([finalizeAndClose(), new Promise((r) => setTimeout(r, settleMs))]);
      teardown();
      return state;
    },
    getState() {
      return inner ? inner.getState() : state;
    },
  };
}
