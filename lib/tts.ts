"use client";

// TTS with five engines behind one interface:
// - cloud (server-side ElevenLabs / OpenAI / Deepgram / Groq / Gemini — the
//   server picks): STREAMED — the first synthesized chunk plays while the rest
//   is still rendering. The production default whenever a key is configured.
// - chatterbox (local server): studio voices + cloning, streamed. Dev/studio.
// - kokoro (on-device neural): natural voice with no key at all, once its
//   ~80MB model is downloaded (warmed automatically when it is the engine).
// - system (speechSynthesis): instant, robotic — the floor that never fails.
//
// THE RULE: the interviewer is never silent. Every path degrades one step —
// cloud/chatterbox → kokoro (if ready) → system — and reports which engine
// actually spoke (lastEngineUsed / SpeakHandle.engineUsed) so the UI can be
// honest about it instead of pretending.

import { ensureKokoroLoading, kokoroReady, kokoroSpeak, kokoroStatus, type KokoroHandle } from "@/lib/tts-kokoro";
import { setAiHue, startPseudoTalking, stopPseudoTalking, tapPlayback } from "@/lib/audio-viz";
import { concatBytes, nextChunkStartTime, parseWavHeader, pcm16ToFloat32 } from "@/lib/wav";
import { splitForSpeech } from "@/lib/sentence-split";
import { castVoice, isVoiceKey, voiceKeyOf } from "@/lib/voice-cast";
import { stripSpeechTags } from "@/lib/speakable";
import { WAV_VOICE_RE } from "@/lib/voices";

const ENGINE_KEY = "pds_voice_engine";
/** An EXPLICIT user pick, kept apart from the auto-resolved cache above. */
const ENGINE_PICK_KEY = "pds_voice_engine_pick";
/** How long play() waits for an in-flight preparation before going live. */
const PREPARE_WAIT_MS = 2500;

/** Only a persona key or a well-formed wav name reaches the server — a junk
 * localStorage value must not turn every request into a 400 (= silence). */
function safeVoice(v?: string): string | undefined {
  if (!v) return undefined;
  if (isVoiceKey(v)) return v;
  return WAV_VOICE_RE.test(v) && !v.includes("..") ? v : undefined;
}

/** Autoplay policy: a context created outside a user gesture is suspended and
 * every `onended` would wait forever. Resume (bounded) and report the truth. */
async function ensureRunning(c: AudioContext): Promise<boolean> {
  if (c.state === "running") return true;
  try {
    await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 600))]);
  } catch {}
  // Re-read after the await — TypeScript's narrowing does not know resume()
  // changes it, so launder through a string comparison.
  return String(c.state) === "running";
}

export type VoiceEngine = "system" | "kokoro" | "cloud" | "chatterbox" | "elevenlabs";

/** Engines whose audio comes from /api/tts. */
export function isServerVoiceEngine(e: VoiceEngine): e is "cloud" | "chatterbox" | "elevenlabs" {
  return e === "cloud" || e === "chatterbox" || e === "elevenlabs";
}

export function getVoiceEngine(): VoiceEngine {
  if (typeof window === "undefined") return "cloud";
  try {
    const v = window.localStorage.getItem(ENGINE_KEY);
    if (v === "kokoro" || v === "chatterbox" || v === "system") return v;
    // "elevenlabs" (stale, pre-cloud) and anything unknown resolve to the
    // server-chosen cloud voice; the server answers 404 when none exists and
    // speak() walks down the chain from there.
    return "cloud";
  } catch {
    return "cloud";
  }
}

/** True when the user has ever explicitly picked a voice (any value stored). */
export function hasStoredVoiceChoice(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(ENGINE_PICK_KEY) !== null;
  } catch {
    return true;
  }
}

/** The user's explicit engine choice, or null when they have never picked one.
 *
 * Deliberately a DIFFERENT key from ENGINE_KEY. ENGINE_KEY caches whatever
 * resolveVoiceEngine() last worked out automatically, and resolveVoiceEngine()
 * writes it on every run — so reading that key back as "the user chose this"
 * would make the first automatic result permanent. One session where the local
 * Chatterbox server happened to be down would pin the app to the on-device
 * voice forever, even after Chatterbox came back. */
export function storedVoicePreference(): VoiceEngine | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(ENGINE_PICK_KEY);
    return v === "kokoro" || v === "chatterbox" || v === "system" || v === "cloud" ? v : null;
  } catch {
    return null;
  }
}

/** Record an explicit choice (a voice picker). Survives auto-resolution. */
export function setVoiceEnginePreference(engine: VoiceEngine | null): void {
  try {
    if (engine === null) window.localStorage.removeItem(ENGINE_PICK_KEY);
    else window.localStorage.setItem(ENGINE_PICK_KEY, engine);
  } catch {}
  if (engine) setVoiceEngine(engine);
}

/** Cache the engine in use for this visit. NOT a user preference — see
 * setVoiceEnginePreference for that. */
export function setVoiceEngine(engine: VoiceEngine): void {
  try {
    window.localStorage.setItem(ENGINE_KEY, engine);
  } catch {}
  if (engine === "kokoro") ensureKokoroLoading();
}

export interface VoiceCapabilities {
  cloud: string | null;
  engines: string[];
  chatterbox: boolean;
}

let capsCache: VoiceCapabilities | null = null;
/** Set when the server said "no cloud voice" — skip the doomed round trip on
 * every later utterance this visit. Cleared by a successful resolve. */
let cloudUnavailable = false;

/** THE SINGLE-VOICE LATCH.
 *
 * Once a server engine has failed, every later utterance goes straight to the
 * on-device voice instead of trying the server again. Without this, each
 * utterance independently retries and independently falls back, so a flaky
 * connection or an exhausted quota produces a reply where sentence 1 is the
 * cloud voice, sentence 2 is Kokoro and sentence 3 is the system voice — which
 * is precisely what "the interviewer has multiple voices" means. Degrading is
 * allowed; degrading *repeatedly, per sentence* is not.
 *
 * Cleared by resolveVoiceEngine() (a fresh interview re-probes) and by
 * resetVoiceSession(). */
let sessionDegraded = false;

/** True once this session gave up on the server voice. UI can surface it. */
export function voiceDegraded(): boolean {
  return sessionDegraded;
}

/** Clear the degrade latch — call when starting a fresh interview. */
export function resetVoiceSession(): void {
  sessionDegraded = false;
}

/** Cloud engines whose free tier is too small to be an automatic default.
 * Groq serves Orpheus at 100 requests/DAY (measured against the live API:
 * x-ratelimit-limit-requests 100, full refill ~24h) — roughly two interviews,
 * after which every line would be re-voiced by something else. It stays
 * available as an explicit pick, never as the automatic choice. */
const METERED_CLOUD_ENGINES = new Set(["groq"]);

function engineIsAvailable(e: VoiceEngine, caps: VoiceCapabilities): boolean {
  if (e === "chatterbox") return caps.chatterbox;
  if (e === "cloud" || e === "elevenlabs") return Boolean(caps.cloud);
  return true; // kokoro / system need nothing from the server
}

/** Ask the server what voices exist and settle on ONE engine for the session.
 *
 * Order (auto): the local Chatterbox server first — no quota, studio voices and
 * native paralinguistic tags ([chuckle], [laugh] …), which is the whole reason
 * it is installed; then the on-device voice, also unmetered and with a single
 * fixed speaker embedding; then a cloud engine, but only one whose quota can
 * survive a real interview. An explicit pick from the voice picker always wins
 * when it is actually available. Safe to call repeatedly; a network failure
 * keeps whatever was stored. */
export async function resolveVoiceEngine(): Promise<VoiceEngine> {
  if (typeof window === "undefined") return "cloud";
  try {
    const res = await fetch("/api/tts", { cache: "no-store" });
    if (!res.ok) throw new Error(`tts_${res.status}`);
    const d = (await res.json()) as Partial<VoiceCapabilities>;
    capsCache = { cloud: d.cloud ?? null, engines: d.engines ?? [], chatterbox: Boolean(d.chatterbox) };
    cloudUnavailable = !capsCache.cloud;
    sessionDegraded = false; // a fresh probe clears last session's degrade latch

    const explicit = storedVoicePreference();
    const engine: VoiceEngine =
      explicit && engineIsAvailable(explicit, capsCache)
        ? explicit
        : capsCache.chatterbox
          ? "chatterbox"
          : capsCache.cloud && !METERED_CLOUD_ENGINES.has(capsCache.cloud)
            ? "cloud"
            : "kokoro";
    setVoiceEngine(engine);
    // Warm the on-device model even when it is not the chosen engine: it is the
    // ONE fallback the whole session degrades to, and it must already be ready
    // if that ever happens, or the rescue itself changes voice.
    ensureKokoroLoading();
    return engine;
  } catch {
    const e = getVoiceEngine();
    ensureKokoroLoading();
    return e;
  }
}

/** Last known server voice capabilities (null until resolveVoiceEngine ran). */
export function voiceCapabilities(): VoiceCapabilities | null {
  return capsCache;
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

/** Autoplay policy: contexts created outside a user gesture start suspended.
 * Call from a click handler (mic check / start) so playback is unlocked. */
export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  try {
    const c = sharedCtx();
    if (c.state === "suspended") void c.resume();
  } catch {}
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
        const list = window.speechSynthesis.getVoices();
        // An empty list (voiceschanged came late) must not be cached forever.
        if (list.length === 0) voicesReady = null;
        resolve(list);
      };
      window.speechSynthesis.addEventListener("voiceschanged", settle, { once: true });
      // Some engines never fire voiceschanged — don't hang the interview.
      setTimeout(settle, 1500);
    });
  }
  return voicesReady;
}

function pickVoice(voices: SpeechSynthesisVoice[], male: boolean): SpeechSynthesisVoice | null {
  const prefs = [/en-IN/i, /en-GB/i, /en-US/i, /^en/i];
  const gender = male ? /male|david|daniel|george|james|ravi|mark/i : /female|zira|susan|hazel|heera|samantha|karen/i;
  for (const p of prefs) {
    const v = voices.find((v) => p.test(v.lang) && gender.test(v.name));
    if (v) return v;
  }
  for (const p of prefs) {
    const v = voices.find((v) => p.test(v.lang));
    if (v) return v;
  }
  return voices[0] ?? null;
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

export interface SpeakOptions {
  rate?: number;
  /** A persona key ("hr", "moderator", …) or a legacy Chatterbox wav name. */
  voice?: string;
  hue?: [number, number, number];
}

function kokoroVoice(voice?: string): string {
  return castVoice("kokoro", voiceKeyOf(voice));
}

function wrapKokoro(h: KokoroHandle): SpeakHandle {
  const engineUsed = h.firstSyllableAt.then<VoiceEngine>(() => {
    lastEngine = "kokoro";
    return "kokoro";
  });
  return { done: h.done, cancel: () => h.cancel(), firstSyllableAt: h.firstSyllableAt, engineUsed };
}

/** A SpeakHandle whose real handle is only decided asynchronously (e.g. after
 * waiting for the on-device model to finish downloading). cancel() before the
 * decision still cancels whatever eventually starts. */
function deferredSpeak(pick: () => Promise<SpeakHandle>): SpeakHandle {
  let cancelled = false;
  let inner: SpeakHandle | null = null;
  let resolveFirst!: (t: number) => void;
  const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));
  let resolveEngine!: (e: VoiceEngine) => void;
  const engineUsed = new Promise<VoiceEngine>((r) => (resolveEngine = r));
  let resolveCancelled!: () => void;
  const cancelledAt = new Promise<void>((r) => (resolveCancelled = r));
  const run = (async () => {
    const h = await pick();
    if (cancelled) {
      h.cancel();
      return;
    }
    inner = h;
    h.firstSyllableAt.then(resolveFirst);
    h.engineUsed.then(resolveEngine);
    await h.done;
  })();
  // `done` must not wait for the decision once cancelled. pick() can be the
  // 8s kokoroReady() hold, and the hooks `await handle.done` right after a
  // barge-in cancel() before they hand the floor to the candidate — a done
  // that resolves only when the model download settles would freeze the
  // interview for those seconds. The decision still runs to completion so
  // whatever it eventually starts is cancelled too.
  const done = Promise.race([run, cancelledAt]).then(() => {
    resolveFirst(Date.now());
    resolveEngine(kokoroStatus() === "ready" ? "kokoro" : "system");
  });
  return {
    done,
    cancel() {
      cancelled = true;
      inner?.cancel();
      resolveCancelled();
    },
    firstSyllableAt,
    engineUsed,
  };
}

/** How long a line waits for the on-device model instead of being spoken in a
 * different voice. A one-off delay is a far smaller flaw than the interviewer
 * changing identity mid-answer. */
const KOKORO_WAIT_MS = 20_000;

/** Kokoro renders a whole chunk before any of it can play, so the first
 * chunk's length IS the time to first audio: a real-browser run measured 5–7 s
 * from "answer recorded" to the first syllable when draw 1 was a full ~8 s
 * sentence. Open with a short clause instead — cut the first sentence at its
 * last clause boundary inside FIRST_CHUNK_MAX — and let the pipelined
 * generate-next-while-playing hide the rest. Same voice, same buffer chain;
 * nothing about identity changes. */
const FIRST_CHUNK_MAX = 72;
const FIRST_CHUNK_MIN = 28;

export function kokoroChunks(text: string): string[] {
  const chunks = splitForSpeech(text);
  if (chunks.length === 0 || chunks[0].length <= FIRST_CHUNK_MAX) return chunks;
  const head = chunks[0];
  // The EARLIEST clause boundary past the floor: render time scales with
  // length, and a comma is a natural pause, so the shortest natural opening
  // wins. Only when no clause boundary exists is a word boundary used — and
  // then the latest one inside the cap, since a mid-clause cut is the less
  // natural seam and deserves the longer run-up.
  let cut = -1;
  for (const sep of [", ", "; ", " — ", " – ", ": "]) {
    const i = head.indexOf(sep, FIRST_CHUNK_MIN - 1);
    if (i !== -1 && i <= FIRST_CHUNK_MAX && (cut === -1 || i + sep.length < cut)) cut = i + sep.length;
  }
  if (cut === -1) {
    const i = head.lastIndexOf(" ", FIRST_CHUNK_MAX);
    if (i >= FIRST_CHUNK_MIN) cut = i + 1;
  }
  if (cut === -1) return chunks;
  return [head.slice(0, cut).trim(), head.slice(cut).trim(), ...chunks.slice(1)].filter(Boolean);
}

/** The on-device / system floor for one utterance — shared by every rescue.
 * Studio speech tags ([chuckle]) mean nothing here and would be read aloud. */
function floorSpeak(text: string, opts?: SpeakOptions): SpeakHandle {
  const clean = stripSpeechTags(text) || text;
  if (kokoroStatus() === "ready") {
    return wrapKokoro(kokoroSpeak(kokoroChunks(clean), kokoroVoice(opts?.voice)));
  }
  ensureKokoroLoading();
  // The model has already failed, or there is no window to load it in: the
  // system voice is genuinely all that is left.
  if (kokoroStatus() === "failed" || typeof window === "undefined") return systemSpeak(clean, opts);
  // Still downloading. HOLD the line for it rather than speaking this sentence
  // in the system voice and the next one in Kokoro — that mid-reply switch is
  // the bug. The preroll normally waits for the model before the interview
  // starts (voiceWarmup), so this hold is the backstop for a reload mid-round;
  // only a model that never arrives falls through.
  return deferredSpeak(async () => {
    const ready = await kokoroReady(KOKORO_WAIT_MS);
    return ready ? wrapKokoro(kokoroSpeak(kokoroChunks(clean), kokoroVoice(opts?.voice))) : systemSpeak(clean, opts);
  });
}

function serverSpeak(text: string, engine: "cloud" | "chatterbox", opts?: SpeakOptions): SpeakHandle {
  let cancelled = false;
  const abort = new AbortController();
  const sources: AudioBufferSourceNode[] = [];
  let fellBack: SpeakHandle | null = null;
  const voice = safeVoice(opts?.voice);

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
      body: JSON.stringify({ text, engine, ...(voice ? { voice } : {}), stream }),
      signal: abort.signal,
    });

  const playBuffered = async (res: Response) => {
    const buf = await res.arrayBuffer();
    if (cancelled) return;
    const c = sharedCtx();
    const audio = await c.decodeAudioData(buf);
    if (cancelled) return;
    if (!(await ensureRunning(c))) throw new Error("audio_suspended");
    // Re-check after the await: cancel() stops the sources it can SEE, and
    // this one does not exist yet — a barge-in landing inside the (up to
    // 600ms) resume window would otherwise start a line nobody can stop.
    if (cancelled) return;
    await new Promise<void>((resolve) => {
      const src = c.createBufferSource();
      src.buffer = audio;
      tapPlayback(c, src); // orb rides the real playback amplitude
      // Watchdog: an interrupted context never fires onended — the interview
      // must not hang on it.
      const guard = setTimeout(resolve, audio.duration * 1000 + 1500);
      src.onended = () => {
        clearTimeout(guard);
        resolve();
      };
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
    if (!(await ensureRunning(c))) {
      void reader.cancel().catch(() => {});
      return false; // the buffered retry surfaces the real failure
    }
    let header: ReturnType<typeof parseWavHeader> = null;
    let pending = new Uint8Array(0);
    let scheduledUntil = 0;
    let started = false;
    let created = 0;
    let endedCount = 0;
    let onAllEnded: (() => void) | null = null;

    // Jitter buffer. Packets are coalesced before they become sources: the
    // first start waits for ~200 ms of audio so a server momentarily slower
    // than real time cannot stutter at every packet, and later packets are
    // merged into ≥60 ms buffers.
    const queued: Float32Array[] = [];
    let queuedLen = 0;
    const schedule = (sampleRate: number) => {
      const buf = c.createBuffer(1, queuedLen, sampleRate);
      const merged = buf.getChannelData(0);
      let off = 0;
      for (const q of queued) {
        merged.set(q, off);
        off += q.length;
      }
      queued.length = 0;
      queuedLen = 0;
      const src = c.createBufferSource();
      src.buffer = buf;
      tapPlayback(c, src);
      created++;
      src.onended = () => {
        endedCount++;
        if (onAllEnded && endedCount >= created) onAllEnded();
      };
      // A drained queue (underrun) re-leads a little further out than the
      // first start, so the next packet has time to arrive behind it.
      const lead = !started ? 0.05 : scheduledUntil < c.currentTime ? 0.08 : 0.03;
      const startAt = nextChunkStartTime(c.currentTime, scheduledUntil, lead);
      scheduledUntil = startAt + buf.duration;
      sources.push(src);
      src.start(startAt);
      if (!started) {
        started = true;
        resolveFirst(Date.now() + Math.round((startAt - c.currentTime) * 1000));
        markSpoke(engine);
      }
    };

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
          queued.push(samples);
          queuedLen += samples.length;
        }
        const threshold = started ? header.sampleRate * 0.06 : header.sampleRate * 0.2;
        if (queuedLen > 0 && (queuedLen >= threshold || eof)) schedule(header.sampleRate);
      }
      if (eof) break;
    }
    if (!started) return false; // header but zero samples — buffered retry
    if (endedCount < created) {
      await new Promise<void>((resolve) => {
        // Watchdog: everything is scheduled, so the end is known — never wait
        // longer than that (+ slack) for onended events that may not come.
        const remainingMs = Math.max(0, (scheduledUntil - c.currentTime) * 1000) + 1500;
        const guard = setTimeout(resolve, remainingMs);
        onAllEnded = () => {
          clearTimeout(guard);
          resolve();
        };
        if (endedCount >= created) onAllEnded();
      });
    }
    return true;
  };

  const done = (async () => {
    try {
      if (engine === "cloud" && cloudUnavailable) throw new Error("tts_404");
      const res = await postTts(true);
      if (!res.ok) {
        if (res.status === 404 && engine === "cloud") cloudUnavailable = true;
        throw new Error(`tts_${res.status}`);
      }
      if (res.body) {
        if (await playStreaming(res.body)) return;
        if (cancelled) return;
        // Streaming unusable (bad header / died early): buffered, SAME engine.
        const retry = await postTts(false);
        if (!retry.ok) throw new Error(`tts_${retry.status}`);
        await playBuffered(retry);
        return;
      }
      await playBuffered(res);
    } catch (err) {
      if (cancelled) return;
      const aborted = err instanceof Error && err.name === "AbortError";
      if (!aborted) {
        console.warn(
          `[tts] ${engine} failed (${err instanceof Error ? err.message : err}) — the REST OF THIS SESSION uses the on-device voice`,
        );
        // Latch the whole session, not just this utterance. Retrying per
        // sentence is what produced a reply in three different voices.
        sessionDegraded = true;
      }
      // THE FLOOR: never silent. On-device Kokoro if it is ready, else the
      // system voice. engineUsed reports the truth so the UI can say so.
      fellBack = floorSpeak(text, opts);
      fellBack.firstSyllableAt.then(resolveFirst);
      fellBack.engineUsed.then(resolveEngine);
      await fellBack.done;
    } finally {
      // Cancelled/empty paths must not hang awaiters (no-ops once resolved).
      // Report the FALLBACK engine when one was used: resolving to `engine`
      // here would claim the server voice spoke even when it never did, which
      // is what made engine_switches_per_turn read zero while the interviewer
      // was audibly changing voice.
      resolveFirst(Date.now());
      resolveEngine(fellBack ? (kokoroStatus() === "ready" ? "kokoro" : "system") : engine);
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

export function speak(text: string, opts?: SpeakOptions): SpeakHandle {
  setAiHue(opts?.hue ?? null); // per-utterance orb tint (GD personas); null = default family
  const engine = getVoiceEngine();
  // Already degraded this session: go straight to the on-device voice. Trying
  // the server again would let a later utterance succeed and flip the
  // interviewer back to a different voice mid-interview.
  if (sessionDegraded && isServerVoiceEngine(engine)) return floorSpeak(text, opts);
  if (engine === "cloud" || engine === "elevenlabs") return serverSpeak(text, "cloud", opts);
  if (engine === "chatterbox") return serverSpeak(text, "chatterbox", opts);
  if (engine === "kokoro") return floorSpeak(text, opts);
  return systemSpeak(text, opts);
}

/** Voice pipelining (streamed turns): the first sentence is already speaking;
 * chain the remainder as a second utterance under ONE composite handle.
 * cancel() covers BOTH utterances (barge-in/cleanup must kill the chained tail
 * too); firstSyllableAt/engineUsed are the FIRST utterance's — the latency
 * anchor stays the first audible syllable. */
export function chainSpeak(first: SpeakHandle, remainderText: string, opts?: SpeakOptions): SpeakHandle {
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
 * something else is happening, so time-to-first-chunk is irrelevant and a
 * single decoded buffer schedules instantly. The engine fallback chain is NOT
 * duplicated here: any failure simply routes play() through normal speak(). */
export function prepareSpeak(text: string, opts?: SpeakOptions): PreparedSpeech {
  const engine = getVoiceEngine();
  // A degraded session has no server bytes to pre-fetch — play() routes through
  // speak(), which the latch already sends to the on-device voice.
  const serverEngine = sessionDegraded
    ? null
    : engine === "chatterbox"
      ? "chatterbox"
      : isServerVoiceEngine(engine)
        ? "cloud"
        : null;
  const abort = new AbortController();
  const voice = safeVoice(opts?.voice);
  let cancelled = false;
  let settled = false;
  let buffer: AudioBuffer | null = null;
  let started: AudioBufferSourceNode | null = null;

  const ready: Promise<void> =
    serverEngine && !(serverEngine === "cloud" && cloudUnavailable)
      ? (async () => {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, engine: serverEngine, ...(voice ? { voice } : {}), stream: false }),
            signal: abort.signal,
          });
          if (!res.ok) {
            if (res.status === 404 && serverEngine === "cloud") cloudUnavailable = true;
            throw new Error(`tts_${res.status}`);
          }
          const bytes = await res.arrayBuffer();
          if (cancelled) return;
          buffer = await sharedCtx().decodeAudioData(bytes);
        })()
          .catch(() => {
            buffer = null; // failed/aborted preparation is silent — play() goes live
          })
          .finally(() => {
            settled = true;
          })
      : ((settled = true), Promise.resolve()); // kokoro/system have no server bytes to pre-fetch

  /** Schedule a decoded buffer NOW. */
  const playBuffer = (audio: AudioBuffer): SpeakHandle => {
    buffer = null; // consumed — a second play() routes live instead of double-scheduling
    setAiHue(opts?.hue ?? null); // mirror speak(): per-utterance orb tint
    const c = sharedCtx();
    const used: VoiceEngine = serverEngine ?? engine;
    // Cancellation must work BEFORE the source node exists. cancel() used to
    // only call started?.stop(), but `started` is null for the whole of the
    // ensureRunning() await below — a barge-in landing in that window was a
    // silent no-op and the line played on over the candidate. GD persona turns
    // now route through prepared buffers, so this is on the interruption path.
    let stopped = false;
    let fallback: SpeakHandle | null = null;
    let resolveFirst!: (t: number) => void;
    const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));
    // Resolved by whichever path actually made sound. A constant `used` here
    // claimed the server voice spoke even when the locked-output branch below
    // handed the line to the floor — the same lie serverSpeak's finally block
    // was fixed for.
    let resolveEngine!: (e: VoiceEngine) => void;
    const engineUsed = new Promise<VoiceEngine>((r) => (resolveEngine = r));
    const done = (async () => {
      if (!(await ensureRunning(c))) {
        if (stopped) return resolveFirst(Date.now());
        // Output locked (autoplay policy): the floor voice can still try.
        fallback = floorSpeak(text, opts);
        fallback.firstSyllableAt.then(resolveFirst);
        fallback.engineUsed.then(resolveEngine);
        await fallback.done;
        return;
      }
      if (stopped) return resolveFirst(Date.now());
      await new Promise<void>((resolve) => {
        const src = c.createBufferSource();
        src.buffer = audio;
        tapPlayback(c, src); // orb rides the real playback amplitude
        const guard = setTimeout(resolve, audio.duration * 1000 + 1500);
        src.onended = () => {
          clearTimeout(guard);
          resolve();
        };
        started = src;
        lastEngine = used;
        resolveFirst(Date.now());
        resolveEngine(used);
        src.start();
      });
    })().finally(() => {
      resolveFirst(Date.now());
      resolveEngine(fallback ? (kokoroStatus() === "ready" ? "kokoro" : "system") : used);
    });
    return {
      done,
      cancel() {
        stopped = true;
        fallback?.cancel();
        try {
          started?.stop();
        } catch {}
      },
      firstSyllableAt,
      engineUsed,
    };
  };

  /** The decoded server buffer, if it may still be played.
   *
   * The latch check matters because preparation and the live draw run
   * CONCURRENTLY: the speech queue prepares draw 2 while draw 1 is still
   * fetching. When draw 1 then fails and latches the session onto the floor
   * voice, draw 2's bytes have often already arrived — and playing them would
   * put the server voice right after the on-device one inside ONE turn, the
   * exact split the latch exists to prevent. A prepared server buffer is
   * therefore only usable while the session is still on the server voice. */
  const usableBuffer = (): AudioBuffer | null => {
    if (!buffer || cancelled) return null;
    if (serverEngine && sessionDegraded) {
      buffer = null; // never played — play() goes through speak(), i.e. the floor
      return null;
    }
    return buffer;
  };

  return {
    ready,
    play(): SpeakHandle {
      const usable = usableBuffer();
      if (usable) return playBuffer(usable);
      if (cancelled || settled) {
        // Nothing to wait for: abort any straggling fetch so two syntheses
        // of the same utterance never run concurrently, and go live.
        abort.abort();
        return speak(text, opts);
      }
      // Still preparing — normal for the opening line, where "Start" is
      // clicked a second after the pre-fetch fired. Wait (bounded) for the
      // decoded buffer instead of aborting it and synthesizing the same line
      // twice; only a stalled preparation falls through to the live path.
      let inner: SpeakHandle | null = null;
      let cancelledPlay = false;
      let resolveFirst!: (t: number) => void;
      const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));
      let resolveEngine!: (e: VoiceEngine) => void;
      const engineUsed = new Promise<VoiceEngine>((r) => (resolveEngine = r));
      const done = (async () => {
        await Promise.race([ready, new Promise((r) => setTimeout(r, PREPARE_WAIT_MS))]);
        if (cancelledPlay) {
          resolveFirst(Date.now());
          resolveEngine(engine);
          return;
        }
        const late = usableBuffer();
        if (late) {
          inner = playBuffer(late);
        } else {
          abort.abort();
          inner = speak(text, opts);
        }
        inner.firstSyllableAt.then(resolveFirst);
        inner.engineUsed.then(resolveEngine);
        await inner.done;
      })();
      return {
        done,
        cancel() {
          cancelledPlay = true;
          inner?.cancel();
        },
        firstSyllableAt,
        engineUsed,
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

/** Per-persona colour for the system voice, which has no cast of its own:
 * pitch/rate nudges keep the GD debaters tellable apart. */
const SYSTEM_STYLE: Record<string, { pitch: number; rate: number; male: boolean }> = {
  hr: { pitch: 1.0, rate: 1.0, male: false },
  technical: { pitch: 0.9, rate: 1.0, male: true },
  moderator: { pitch: 1.05, rate: 0.98, male: false },
  dominator: { pitch: 0.8, rate: 1.08, male: true },
  data: { pitch: 1.1, rate: 1.02, male: false },
  fence: { pitch: 0.95, rate: 0.94, male: true },
};

function systemSpeak(text: string, opts?: SpeakOptions): SpeakHandle {
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
  const style = SYSTEM_STYLE[voiceKeyOf(opts?.voice)] ?? SYSTEM_STYLE.hr;

  const done = (async () => {
    const voices = await loadVoices();
    const voice = pickVoice(voices, style.male);
    const chunks = splitForSpeech(text);
    let first = true;
    for (const chunk of chunks) {
      if (cancelled) break;
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(chunk);
        if (voice) u.voice = voice;
        u.rate = opts?.rate ?? style.rate;
        u.pitch = style.pitch;
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
