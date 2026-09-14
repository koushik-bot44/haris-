import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════════
// THE BROWSER VOICE PIPELINE, AT ITS EDGES.
//
// One invariant sits above every other in this app: ONE INTERVIEWER = ONE
// VOICE. A reply that is half ElevenLabs and half the robotic system voice
// does not read as "a degraded connection" — it reads as two different people
// interviewing you, and it is the single most damaging bug this product can
// ship. Every describe below protects one of the mechanisms that hold that
// line: the session degrade latch, the two-draw rule, the streaming player's
// same-engine retries, and the voice cast that gives each persona a distinct
// speaker on every engine.
//
// These are the failure paths — dropped sockets, exotic WAV headers, barge-in
// landing in the two-millisecond window between two draws — because that is
// where the voice actually changes. The happy path was never the problem.
// ═══════════════════════════════════════════════════════════════════════════

// ——— module mocks (hoisted state so the factories can reach it) ———

const kk = vi.hoisted(() => ({
  status: "ready" as "off" | "loading" | "ready" | "failed",
  ensureCalls: 0,
  readyResult: true,
  readyWaits: [] as number[],
  /** When set, kokoroReady() blocks on this — "the model is still downloading". */
  gate: null as Promise<void> | null,
  utterances: [] as { chunks: string[]; voice: string; cancelled: boolean }[],
}));

vi.mock("@/lib/tts-kokoro", () => ({
  PRIYA_VOICE: "af_heart",
  ensureKokoroLoading: () => {
    kk.ensureCalls++;
  },
  kokoroStatus: () => kk.status,
  kokoroReady: async (ms: number) => {
    kk.readyWaits.push(ms);
    if (kk.gate) await kk.gate;
    return kk.readyResult;
  },
  kokoroSpeak: (chunks: string[], voice: string) => {
    const rec = { chunks, voice, cancelled: false };
    kk.utterances.push(rec);
    let resolveFirst!: (t: number) => void;
    const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    queueMicrotask(() => {
      resolveFirst(Date.now());
      resolveDone();
    });
    return {
      done,
      firstSyllableAt,
      cancel() {
        rec.cancelled = true;
        resolveFirst(Date.now());
        resolveDone();
      },
    };
  },
}));

const viz = vi.hoisted(() => ({ hues: [] as unknown[], taps: 0 }));

vi.mock("@/lib/audio-viz", () => ({
  setAiHue: (h: unknown) => void viz.hues.push(h),
  startPseudoTalking: () => {},
  stopPseudoTalking: () => {},
  tapPlayback: (_ctx: unknown, node: unknown) => {
    viz.taps++;
    return node;
  },
}));

import { concatBytes, nextChunkStartTime, parseWavHeader, pcm16ToFloat32 } from "@/lib/wav";
import {
  castVoice,
  chatterboxVoiceFor,
  CLOUD_TTS_ENGINES,
  isVoiceKey,
  VOICE_CAST,
  VOICE_KEYS,
  VOICE_STYLE,
  voiceKeyOf,
  type VoiceKey,
} from "@/lib/voice-cast";
import { WAV_VOICE_RE } from "@/lib/voices";
import {
  chainSpeak,
  isServerVoiceEngine,
  lastEngineUsed,
  prepareSpeak,
  resetVoiceSession,
  resolveVoiceEngine,
  speak,
  voiceDegraded,
  type SpeakHandle,
  type VoiceEngine,
} from "@/lib/tts";

// ═══════════════════════════ WAV byte builders ═════════════════════════════

const SR = 24_000;

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}
function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
/** A RIFF chunk, word-aligned like the spec demands. `size` may lie (streaming
 * writers and truncated transfers both do). */
function chunk(id: string, payload: number[], size = payload.length): number[] {
  return [...ascii(id), ...u32(size), ...payload, ...(payload.length % 2 ? [0] : [])];
}
function fmtChunk(o: { format?: number; channels?: number; sampleRate?: number; bits?: number; cbSize?: boolean } = {}): number[] {
  const { format = 1, channels = 1, sampleRate = SR, bits = 16, cbSize = false } = o;
  const blockAlign = (channels * bits) / 8;
  return chunk("fmt ", [
    ...u16(format),
    ...u16(channels),
    ...u32(sampleRate),
    ...u32(sampleRate * blockAlign),
    ...u16(blockAlign),
    ...u16(bits),
    ...(cbSize ? u16(0) : []),
  ]);
}
function buildWav(
  o: {
    format?: number;
    channels?: number;
    sampleRate?: number;
    bits?: number;
    cbSize?: boolean;
    streaming?: boolean;
    before?: number[];
    between?: number[];
    data?: number[];
  } = {},
): Uint8Array<ArrayBuffer> {
  const { streaming = false, before = [], between = [], data = [] } = o;
  const body = [...before, ...fmtChunk(o), ...between, ...chunk("data", data, streaming ? 0xffffffff : data.length)];
  return new Uint8Array([...ascii("RIFF"), ...u32(streaming ? 0xffffffff : 4 + body.length), ...ascii("WAVE"), ...body]);
}
/** Little-endian PCM16 bytes for the given sample values. */
function pcmBytes(samples: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2);
  const dv = new DataView(out.buffer);
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true));
  return out;
}
/** A deterministic, non-constant sample pattern — a constant one would hide
 * off-by-one errors in the remainder/reassembly path. */
function ramp(n: number, from = 0): number[] {
  return Array.from({ length: n }, (_, i) => (((i + from) * 37) % 2001) - 1000);
}

// ═════════════════════ 1. WAV headers off the wire ═════════════════════════

describe("parseWavHeader — headers as they actually arrive from a socket", () => {
  // The streaming player parses the header out of a GROWING buffer: it may see
  // 3 bytes, then 19, then the rest. Getting this wrong has exactly two
  // outcomes, both silent-interviewer bugs — throwing on a header that is
  // merely incomplete (the whole utterance is abandoned), or claiming success
  // on bytes that are not a header yet (garbage is scheduled as audio).

  it("first parses at exactly the 44th byte when the header trickles in one byte at a time", () => {
    const full = buildWav({ streaming: true, data: [...pcmBytes(ramp(8))] });
    let acc = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
    let parsedAt = -1;
    for (let i = 0; i < 44; i++) {
      acc = concatBytes(acc, full.subarray(i, i + 1));
      if (parseWavHeader(acc)) {
        parsedAt = acc.length;
        break;
      }
    }
    expect(parsedAt).toBe(44);
  });

  it.each([1, 4, 11, 12, 20, 36, 43])("survives a header split across two network chunks at byte %i", (cut) => {
    const full = buildWav({ streaming: true });
    const first = full.subarray(0, cut) as Uint8Array<ArrayBuffer>;
    expect(parseWavHeader(first)).toBeNull(); // incomplete is NOT an error
    const joined = concatBytes(first, full.subarray(cut) as Uint8Array<ArrayBuffer>);
    expect(parseWavHeader(joined)).toEqual({ sampleRate: SR, numChannels: 1, bitsPerSample: 16, dataOffset: 44 });
  });

  it("waits for a fmt payload that has only partly arrived instead of reading past it", () => {
    // The chunk HEADER is complete ("fmt " + size) but only 8 of its 16 payload
    // bytes are here. Reading on would invent a sample rate out of nothing.
    const full = buildWav({ streaming: true });
    expect(parseWavHeader(full.subarray(0, 28) as Uint8Array<ArrayBuffer>)).toBeNull();
  });

  it("accepts a fmt chunk carrying the optional cbSize field (18-byte fmt)", () => {
    const h = parseWavHeader(buildWav({ cbSize: true, streaming: true }));
    expect(h).toEqual({ sampleRate: SR, numChannels: 1, bitsPerSample: 16, dataOffset: 46 });
  });

  it.each([
    ["WAVE_FORMAT_EXTENSIBLE", 0xfffe],
    ["IEEE float", 3],
    ["MS ADPCM", 2],
    ["A-law", 6],
    ["mu-law", 7],
  ])("refuses %s rather than playing it as PCM noise", (_name, format) => {
    expect(() => parseWavHeader(buildWav({ format }))).toThrow("wav_not_pcm");
  });

  it.each([
    [2, 16],
    [1, 8],
    [2, 32],
  ])("reports channels=%i bits=%i faithfully so the caller can refuse it", (channels, bits) => {
    const h = parseWavHeader(buildWav({ channels, bits }));
    expect(h?.numChannels).toBe(channels);
    expect(h?.bitsPerSample).toBe(bits);
  });

  it("does not mistake the bytes 'data' INSIDE a LIST payload for the data chunk", () => {
    // Chunks are skipped by declared size, never by scanning for a tag. A tag
    // scan would put dataOffset in the middle of a metadata blob and the first
    // "samples" would be the artist name.
    const decoy = [...ascii("data"), ...u32(0), ...ascii("INFOxxxx")];
    const h = parseWavHeader(buildWav({ between: chunk("LIST", decoy), data: [...pcmBytes(ramp(4))] }));
    expect(h?.dataOffset).toBe(44 + 8 + decoy.length);
  });

  it("skips unknown chunks that appear BEFORE fmt", () => {
    const junk = chunk("JUNK", new Array(28).fill(0));
    const h = parseWavHeader(buildWav({ before: junk }));
    expect(h?.dataOffset).toBe(44 + junk.length);
    expect(h?.sampleRate).toBe(SR);
  });

  it("returns null (not a throw) when a chunk declares more bytes than have arrived", () => {
    const partial = new Uint8Array([...ascii("RIFF"), ...u32(0xffffffff), ...ascii("WAVE"), ...chunk("LIST", [1, 2, 3], 4096)]);
    expect(parseWavHeader(partial)).toBeNull();
  });

  it("parses a header whose data chunk is still empty (server wrote the frame first)", () => {
    const h = parseWavHeader(buildWav({ streaming: true, data: [] }));
    expect(h?.dataOffset).toBe(44);
  });

  it.each([
    ["an MP3 (ID3) tag", "ID3v2.4.0 TALB xxxx"],
    ["an HTML error page", "<!DOCTYPE html><html><body>502"],
    ["a JSON error body", '{"error":"quota_exceeded","code":429}'],
    ["an Ogg/Opus stream", "OggS 0 OpusHead xx"],
    ["RIFX (big-endian)", "RIFX\u0000\u0000\u0000\u0000WAVEfmt "],
    ["lowercase riff", "riff\u0000\u0000\u0000\u0000wavefmt "],
  ])("rejects %s outright so the caller can retry buffered", (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(12); // fewer bytes than this and there is nothing to judge yet
    expect(() => parseWavHeader(new Uint8Array(ascii(text)))).toThrow("not_wav");
  });

  it("withholds judgement below 12 bytes — even on obvious garbage", () => {
    // Under 12 bytes there is not enough to know; declaring "not_wav" here
    // would abandon a perfectly good stream whose first packet was tiny.
    for (const s of ["", "O", "Ogg", "OggSxxxx", "RIFF"]) {
      expect(parseWavHeader(new Uint8Array(ascii(s)))).toBeNull();
    }
  });

  it("puts dataOffset exactly on the first PCM byte (a one-byte slip inverts every sample)", () => {
    const values = ramp(64);
    const wav = buildWav({ data: [...pcmBytes(values)] });
    const h = parseWavHeader(wav)!;
    const { samples, remainder } = pcm16ToFloat32(wav.subarray(h.dataOffset) as Uint8Array<ArrayBuffer>);
    expect(remainder.length).toBe(0);
    expect(Array.from(samples)).toEqual(values.map((v) => v / 32768));
  });
});

// ═══════════════ 2. PCM16 decoding across packet boundaries ════════════════

describe("pcm16ToFloat32 — samples that straddle two network packets", () => {
  // TCP does not respect sample boundaries. Every odd-length packet leaves half
  // a sample behind; dropping it shifts the ENTIRE remaining stream by one byte
  // and turns speech into white noise, so the remainder contract is load-bearing.

  it.each([1, 3, 5, 7, 9, 1001])("keeps the trailing half-sample of a %i-byte packet", (len) => {
    const bytes = new Uint8Array(len).map((_, i) => (i * 31) % 256) as Uint8Array<ArrayBuffer>;
    const { samples, remainder } = pcm16ToFloat32(bytes);
    expect(samples.length).toBe((len - 1) / 2);
    expect(remainder.length).toBe(1);
    expect(remainder[0]).toBe(bytes[len - 1]);
  });

  it("reassembles a stream fed one byte at a time into the exact original samples", () => {
    const values = ramp(300);
    const all = pcmBytes(values);
    let pending = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
    const out: number[] = [];
    for (let i = 0; i < all.length; i++) {
      pending = concatBytes(pending, all.subarray(i, i + 1) as Uint8Array<ArrayBuffer>);
      const { samples, remainder } = pcm16ToFloat32(pending);
      out.push(...Array.from(samples));
      pending = remainder;
    }
    expect(pending.length).toBe(0);
    expect(out).toEqual(values.map((v) => v / 32768));
  });

  it("returns a remainder that does not alias the packet buffer", () => {
    // The remainder is carried into the NEXT packet via concatBytes. If it were
    // a view onto a buffer the caller may reuse, the carried byte would change
    // under it and one sample per packet would be corrupt.
    const bytes = new Uint8Array([0x11, 0x22, 0x33]) as Uint8Array<ArrayBuffer>;
    const { remainder } = pcm16ToFloat32(bytes);
    bytes[2] = 0xff;
    expect(remainder[0]).toBe(0x33);
  });

  it("never produces a sample outside [-1, 1)", () => {
    const extremes = pcmBytes([-32768, 32767, 0, -1, 1, -16384, 16384]);
    const { samples } = pcm16ToFloat32(extremes);
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThan(1);
    }
    expect(samples[0]).toBe(-1);
    expect(samples[1]).toBeCloseTo(0.99997, 5);
  });

  it("decodes a long packet without losing the ends", () => {
    const values = ramp(120_000);
    const { samples, remainder } = pcm16ToFloat32(pcmBytes(values));
    expect(samples.length).toBe(values.length);
    expect(remainder.length).toBe(0);
    expect(samples[0]).toBe(values[0] / 32768);
    expect(samples[samples.length - 1]).toBe(values[values.length - 1] / 32768);
  });
});

// ══════════════════ 3. The gapless scheduler's clock math ══════════════════

describe("nextChunkStartTime — never schedules audio in the past", () => {
  // A start time earlier than ctx.currentTime does not delay the chunk, it
  // CLIPS its head: the Web Audio clock has already passed that moment. Losing
  // 30ms off the front of every packet is exactly what "the voice sounds
  // chopped" is, so both invariants are pinned here over a hostile table.

  it.each<[number, number, number]>([
    [0, 0, 0.03],
    [10, 0, 0.03],
    [10, 14.2, 0.03],
    [20, 14.2, 0.03],
    [1e6, 1e6 - 5, 0.03],
    [5, 5, 0],
    [5, -100, 0.05],
    [0.0001, 0.00005, 0.0001],
    [1234.5678, 1234.5679, 0.03],
  ])("now=%f queued=%f lead=%f stays at or ahead of both", (now, until, lead) => {
    const t = nextChunkStartTime(now, until, lead);
    expect(t).toBeGreaterThanOrEqual(now);
    expect(t).toBeGreaterThanOrEqual(until);
  });

  it("re-anchors to now after an underrun instead of trusting the stale queue end", () => {
    // The queue drained while the server was slow. Butting against the old end
    // would schedule 6 seconds in the past — i.e. drop the packet entirely.
    expect(nextChunkStartTime(20, 14.2, 0.08)).toBeCloseTo(20.08);
  });

  it("with no lead-in it is exactly max(now, queued)", () => {
    expect(nextChunkStartTime(5, 5, 0)).toBe(5);
    expect(nextChunkStartTime(5, 4.9, 0)).toBe(5);
    expect(nextChunkStartTime(5, 5.1, 0)).toBeCloseTo(5.1);
  });

  it("chains 50 packets with no overlap and no silence between them", () => {
    let scheduledUntil = 0;
    const now = 3;
    const starts: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = nextChunkStartTime(now, scheduledUntil, 0.03);
      if (starts.length) expect(start).toBe(scheduledUntil); // butts exactly
      starts.push(start);
      scheduledUntil = start + 0.06;
    }
    expect(starts[0]).toBeCloseTo(3.03);
    expect(scheduledUntil).toBeCloseTo(3.03 + 50 * 0.06);
  });
});

// ═════════════════════ 4. The cast: one persona, one voice ═════════════════

describe("voice cast — every engine casts every persona, and never twice", () => {
  // The GD room has four participants talking to each other. If two of them
  // resolve to the same provider voice, the transcript says two people while
  // the audio is one person arguing with themselves. That shipped once: an
  // early Groq cast used "hannah" for hr, moderator AND data, so the GD
  // moderator and the data debater were literally the same speaker.

  const ALL_ENGINES = [...CLOUD_TTS_ENGINES, "kokoro"] as const;

  it.each(ALL_ENGINES)("%s gives all six personas SIX distinct voices", (engine) => {
    const ids = VOICE_KEYS.map((k) => VOICE_CAST[engine][k]);
    expect(new Set(ids).size).toBe(VOICE_KEYS.length);
  });

  it.each(ALL_ENGINES)("%s defines a non-empty, untrimmed-clean id for every persona", (engine) => {
    for (const key of VOICE_KEYS) {
      const id = VOICE_CAST[engine][key];
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      expect(id).toBe(id.trim()); // a stray space is a 400 from the provider
    }
  });

  it("groq's cast is exactly the six voices Orpheus accepts", () => {
    // The live API rejects anything else with "voice must be one of the
    // following voices: [autumn diana hannah austin daniel troy]" — a rejected
    // request is a silent interviewer, so this list is a contract, not a taste.
    expect(new Set(Object.values(VOICE_CAST.groq))).toEqual(
      new Set(["autumn", "diana", "hannah", "austin", "daniel", "troy"]),
    );
  });

  it("VOICE_CAST covers every cloud engine plus kokoro, and nothing else", () => {
    expect(new Set(Object.keys(VOICE_CAST))).toEqual(new Set([...CLOUD_TTS_ENGINES, "kokoro"]));
  });

  it("VOICE_STYLE describes every persona, distinctly", () => {
    // A missing style prompt silently makes two personas sound identical on
    // engines that take delivery instructions.
    for (const key of VOICE_KEYS) expect(VOICE_STYLE[key]?.length).toBeGreaterThan(20);
    expect(new Set(Object.values(VOICE_STYLE)).size).toBe(VOICE_KEYS.length);
  });

  it("the chatterbox cast is six distinct, traversal-safe wav names that round-trip", () => {
    const names = VOICE_KEYS.map(chatterboxVoiceFor);
    expect(new Set(names).size).toBe(VOICE_KEYS.length);
    for (const [i, name] of names.entries()) {
      expect(WAV_VOICE_RE.test(name)).toBe(true);
      expect(name).not.toContain("..");
      expect(voiceKeyOf(name)).toBe(VOICE_KEYS[i]);
    }
  });

  it.each(ALL_ENGINES)("%s: an env override re-casts the interviewers only, never the GD room", (engine) => {
    const overrides = { [engine]: "OVERRIDDEN" } as Partial<Record<typeof engine, string>>;
    expect(castVoice(engine, "hr", overrides)).toBe("OVERRIDDEN");
    expect(castVoice(engine, "technical", overrides)).toBe("OVERRIDDEN");
    for (const key of ["moderator", "dominator", "data", "fence"] as const) {
      expect(castVoice(engine, key, overrides)).toBe(VOICE_CAST[engine][key]);
    }
  });

  it.each<[string, string | undefined]>([
    ["empty string", ""],
    ["undefined", undefined],
  ])("an override of %s falls through to the cast instead of asking for a nameless voice", (_label, override) => {
    expect(castVoice("openai", "hr", { openai: override })).toBe(VOICE_CAST.openai.hr);
  });

  it.each<[string, string | null | undefined, VoiceKey]>([
    ["a persona key", "moderator", "moderator"],
    ["a legacy wav name", "Axel.wav", "dominator"],
    ["an upper-case wav name", "EMILY.WAV", "hr"],
    ["null", null, "hr"],
    ["undefined", undefined, "hr"],
    ["empty", "", "hr"],
    ["whitespace only", "   ", "hr"],
    ["a padded key", " hr ", "hr"],
    ["an upper-case key", "HR", "hr"],
    ["a traversal attempt", "../../etc/passwd.wav", "hr"],
    ["a script injection", "<script>alert(1)</script>", "hr"],
    ["a SQL-looking string", "hr'; DROP TABLE voices;--", "hr"],
    ["unicode", "モデレーター", "hr"],
    ["a newline-smuggled key", "moderator\ndominator", "hr"],
  ])("voiceKeyOf(%s) resolves to a real persona", (_label, input, expected) => {
    expect(voiceKeyOf(input)).toBe(expected);
  });

  it("voiceKeyOf never returns a key the cast cannot serve, even for a 10k junk string", () => {
    const key = voiceKeyOf("x".repeat(10_000));
    expect(isVoiceKey(key)).toBe(true);
    expect(VOICE_CAST.kokoro[key]).toBeTruthy();
  });
});

// ═════════════════ Browser fakes for the real tts.ts pipeline ══════════════

class FakeAudioBuffer {
  readonly duration: number;
  readonly length: number;
  private readonly ch: Float32Array;
  constructor(length: number, sampleRate: number) {
    this.length = length;
    this.ch = new Float32Array(length);
    this.duration = length / sampleRate;
  }
  getChannelData(): Float32Array {
    return this.ch;
  }
  copyToChannel(src: Float32Array): void {
    this.ch.set(src);
  }
}

class FakeSource {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  start(when = 0): void {
    this.startedAt = when;
    queueMicrotask(() => this.onended?.());
  }
  stop(): void {
    this.stopped = true;
  }
}

let ctxRef: FakeAudioContext | null = null;
const createdSources: FakeSource[] = [];
let failDecode = false;

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  constructor() {
    ctxRef = this;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(length, sampleRate);
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    createdSources.push(s);
    return s;
  }
  async decodeAudioData(): Promise<FakeAudioBuffer> {
    if (failDecode) throw new Error("EncodingError");
    return new FakeAudioBuffer(4800, SR);
  }
}

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

type TtsResponse = { ok: boolean; status?: number; body?: unknown; arrayBuffer?: () => Promise<ArrayBuffer> };

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<TtsResponse>) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}
function bodyOf(f: ReturnType<typeof stubFetch>, i = 0): { text: string; engine: string; voice?: string; stream: boolean } {
  return JSON.parse(String(f.mock.calls[i]?.[1]?.body ?? "{}"));
}
function buffered(): TtsResponse {
  return { ok: true, body: null, arrayBuffer: async () => new ArrayBuffer(64) };
}
/** A request that never answers until it is aborted — exactly what a real
 * fetch does when the AbortController fires: reject with an AbortError. */
function hangingFetch() {
  return stubFetch(
    (_url, init) =>
      new Promise<TtsResponse>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The user aborted a request.");
          e.name = "AbortError";
          reject(e);
        });
      }),
  );
}
function streamOf(chunks: Uint8Array[], o: { failAt?: number; gateAt?: number; gate?: Promise<void> } = {}): TtsResponse {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (o.gate && i === o.gateAt) await o.gate;
      if (i === o.failAt) return c.error(new Error("socket_dropped"));
      if (i >= chunks.length) return c.close();
      c.enqueue(chunks[i++]);
    },
  });
  return { ok: true, body };
}
/** Header + PCM for `sampleCount` samples, split into `parts` packets. */
function wavPackets(sampleCount: number, sizes: number[], o: { channels?: number; bits?: number } = {}): Uint8Array[] {
  const header = buildWav({ streaming: true, ...o });
  const pcm = pcmBytes(ramp(sampleCount));
  const out: Uint8Array[] = [header];
  let off = 0;
  for (const s of sizes) {
    out.push(pcm.subarray(off, off + s));
    off += s;
  }
  if (off < pcm.length) out.push(pcm.subarray(off));
  return out;
}
function totalScheduledSamples(): number {
  return createdSources.reduce((n, s) => n + (s.buffer?.length ?? 0), 0);
}

let storage: ReturnType<typeof makeStorage>;
let warn: ReturnType<typeof vi.spyOn>;

async function freshSession(): Promise<void> {
  // A fresh interview: the probe clears the degrade latch AND the
  // cloud-unavailable flag, and pins this session to the cloud engine.
  stubFetch(async () => ({ ok: true, json: async () => ({ cloud: "elevenlabs", engines: ["elevenlabs"], chatterbox: false }) }) as unknown as TtsResponse);
  await resolveVoiceEngine();
  resetVoiceSession();
}

beforeEach(async () => {
  storage = makeStorage();
  vi.stubGlobal("window", { localStorage: storage }); // no speechSynthesis → the system floor is a silent no-op
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  createdSources.length = 0;
  failDecode = false;
  kk.status = "ready";
  kk.ensureCalls = 0;
  kk.readyResult = true;
  kk.gate = null;
  kk.readyWaits.length = 0;
  kk.utterances.length = 0;
  viz.hues.length = 0;
  await freshSession();
  if (ctxRef) {
    ctxRef.state = "running";
    ctxRef.currentTime = 0;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
});

// ═══════════════════ 5. THE SESSION DEGRADE LATCH ══════════════════════════

describe("the session degrade latch — one failure, one voice, for the rest of the interview", () => {
  // Without the latch, every utterance retries the server independently and
  // falls back independently. A flaky connection then produces sentence 1 in
  // the cloud voice, sentence 2 in Kokoro and sentence 3 in the system voice:
  // that IS the "the interviewer has multiple voices" bug. Degrading once is
  // acceptable; degrading per sentence is not, and coming BACK is worse.

  it("starts clean and latches the moment the server voice fails", async () => {
    expect(voiceDegraded()).toBe(false);
    stubFetch(async () => ({ ok: false, status: 500 }));
    await speak("The server just died.").done;
    expect(voiceDegraded()).toBe(true);
    expect(warn).toHaveBeenCalled(); // the operator is told, once
  });

  it("makes ZERO further network calls once latched", async () => {
    const f = stubFetch(async () => ({ ok: false, status: 500 }));
    await speak("First line.").done;
    expect(f).toHaveBeenCalledTimes(1);
    await speak("Second line.").done;
    await speak("Third line.").done;
    expect(f).toHaveBeenCalledTimes(1); // the doomed round trip is skipped
  });

  it("speaks five consecutive utterances in the SAME voice after a failure", async () => {
    stubFetch(async () => ({ ok: false, status: 429 }));
    const engines: VoiceEngine[] = [];
    for (const line of ["One.", "Two here.", "Three now.", "Four then.", "Five last."]) {
      const h = speak(line, { voice: "hr" });
      engines.push(await h.engineUsed);
      await h.done;
    }
    expect(new Set(engines).size).toBe(1);
    expect(engines[0]).toBe("kokoro");
  });

  it("still speaks the utterance that failed — the interviewer is never silent", async () => {
    stubFetch(async () => ({ ok: false, status: 503 }));
    const h = speak("Tell me about a hard bug.", { voice: "technical" });
    await expect(h.engineUsed).resolves.toBe("kokoro");
    await h.done;
    expect(kk.utterances).toHaveLength(1);
    expect(lastEngineUsed()).toBe("kokoro");
  });

  it("reports the FALLBACK engine, never the engine that was asked for", async () => {
    // engineUsed resolving to the requested engine is what made the
    // engine-switches metric read zero while the voice was audibly changing.
    kk.status = "failed"; // no on-device model either → the system floor
    stubFetch(async () => ({ ok: false, status: 500 }));
    const h = speak("Falling all the way down.");
    await expect(h.engineUsed).resolves.toBe("system");
    await h.done;
  });

  it.each([400, 401, 403, 429, 500, 502, 503])("HTTP %i latches the session and still speaks", async (status) => {
    const f = stubFetch(async () => ({ ok: false, status }));
    await speak("A line that must be heard.").done;
    expect(voiceDegraded()).toBe(true);
    expect(kk.utterances).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a rejected connection latches just as a bad status does", async () => {
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await speak("Offline mid-interview.").done;
    expect(voiceDegraded()).toBe(true);
  });

  it("CANCELLING an utterance is not a failure and must not latch the session", async () => {
    // Barge-in aborts the fetch. Treating that as a server failure would pin
    // the whole interview to the fallback voice the first time the candidate
    // interrupted — a user action silently downgrading the product.
    const f = hangingFetch();
    const h = speak("The candidate interrupts this line.");
    await Promise.resolve();
    h.cancel();
    await h.done;
    expect(voiceDegraded()).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    stubFetch(async () => ({ ok: true, body: null, arrayBuffer: async () => new ArrayBuffer(8) }));
    const next = speak("And the next line still tries the server.");
    await expect(next.engineUsed).resolves.toBe("cloud");
    await next.done;
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an AbortError from the network layer does not latch either", async () => {
    stubFetch(async () => {
      const e = new Error("The user aborted a request.");
      e.name = "AbortError";
      throw e;
    });
    const h = speak("Aborted upstream.");
    await h.done;
    expect(voiceDegraded()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(kk.utterances).toHaveLength(1); // but it still gets spoken
  });

  it("resetVoiceSession() clears the latch so a NEW interview re-probes", async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));
    await speak("Old interview.").done;
    expect(voiceDegraded()).toBe(true);

    resetVoiceSession();
    expect(voiceDegraded()).toBe(false);
    const f = stubFetch(async () => buffered());
    const h = speak("New interview.");
    await expect(h.engineUsed).resolves.toBe("cloud");
    await h.done;
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a 404 marks the cloud voice gone: even after a reset, no doomed round trip", async () => {
    // 404 means "this deployment has no cloud voice at all" — unlike a 500 it
    // cannot recover within the page, so only a fresh capability probe clears it.
    stubFetch(async () => ({ ok: false, status: 404 }));
    await speak("No cloud configured.").done;
    resetVoiceSession();
    const f = stubFetch(async () => buffered());
    await speak("Still no cloud.").done;
    expect(f).not.toHaveBeenCalled();
    expect(voiceDegraded()).toBe(true);

    await freshSession(); // the probe says the cloud is back
    const f2 = stubFetch(async () => buffered());
    await speak("The probe re-enabled it.").done;
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it("chainSpeak keeps ONE voice across both halves of a pipelined turn", async () => {
    // The remainder of a turn is a SEPARATE speak() call. If the latch did not
    // outlive the first call, the opening sentence would be Kokoro and the rest
    // would be the cloud voice — the exact split this app exists to avoid.
    const f = stubFetch(async () => ({ ok: false, status: 500 }));
    const first = speak("First half of the answer.", { voice: "hr" });
    const chained = chainSpeak(first, "And the entire remainder of it.", { voice: "hr" });
    await chained.done;
    expect(f).toHaveBeenCalledTimes(1); // only the first half ever hit the network
    expect(kk.utterances).toHaveLength(2);
    expect(new Set(kk.utterances.map((u) => u.voice)).size).toBe(1);
    await expect(chained.engineUsed).resolves.toBe("kokoro");
  });

  it("chainSpeak.cancel() before the first half ends means the tail never speaks", async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));
    const first = speak("Cut me off.", { voice: "hr" });
    const chained = chainSpeak(first, "This must never be heard.", { voice: "hr" });
    chained.cancel();
    await chained.done;
    expect(kk.utterances.map((u) => u.chunks.join(" "))).not.toContain("This must never be heard.");
  });

  it("prepareSpeak pre-fetches nothing in a degraded session and play() lands on the floor", async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));
    await speak("Degrade me.").done;

    const f = stubFetch(async () => buffered());
    const p = prepareSpeak("A speculative next question.", { voice: "moderator" });
    await p.ready;
    expect(f).not.toHaveBeenCalled();
    const h = p.play();
    await expect(h.engineUsed).resolves.toBe("kokoro");
    await h.done;
    expect(f).not.toHaveBeenCalled();
  });

  it("a server buffer prepared BEFORE the latch flipped is discarded, not played after the floor voice", async () => {
    // The speech queue prepares draw 2 while draw 1 is still in flight. When
    // draw 1 fails and latches the session, draw 2's bytes have usually
    // already been decoded — playing them puts the server voice right after
    // the on-device one inside ONE turn.
    const f = stubFetch(async (_url, init) =>
      JSON.parse(String(init?.body)).stream ? ({ ok: false, status: 429 } as TtsResponse) : buffered(),
    );
    const rest = prepareSpeak("And here is the entire remainder of the answer.", { voice: "hr" });
    await rest.ready; // decoded and waiting
    await speak("The opening sentence.", { voice: "hr" }).done; // 429 → latched, spoken by kokoro
    expect(voiceDegraded()).toBe(true);
    expect(kk.utterances).toHaveLength(1);

    const h = rest.play();
    await expect(h.engineUsed).resolves.toBe("kokoro");
    await h.done;
    expect(kk.utterances).toHaveLength(2); // the remainder went to the floor too
    expect(createdSources).toHaveLength(0); // the decoded server audio never played
    expect(f).toHaveBeenCalledTimes(2); // and nothing else hit the network
  });

  it("a prepared buffer whose output is locked reports the FLOOR engine it actually used", async () => {
    stubFetch(async () => buffered());
    const p = prepareSpeak("Autoplay-locked remainder.", { voice: "hr" });
    await p.ready;
    if (ctxRef) ctxRef.state = "suspended"; // resume() cannot unlock it outside a gesture
    const h = p.play();
    await expect(h.engineUsed).resolves.toBe("kokoro");
    await h.done;
    expect(kk.utterances).toHaveLength(1);
    expect(lastEngineUsed()).toBe("kokoro");
  });

  it("cancel() inside the buffered path's resume window never starts the source", async () => {
    // ensureRunning() awaits resume() for up to 600ms; cancel() only stops
    // sources that already exist. A barge-in in that window used to start the
    // line AFTER the stop, with nothing left to stop it.
    stubFetch(async () => buffered());
    let unlock!: () => void;
    const resumed = new Promise<void>((r) => (unlock = r));
    const ctx = ctxRef!;
    const realResume = ctx.resume;
    ctx.state = "suspended";
    ctx.resume = () =>
      resumed.then(() => {
        ctx.state = "running";
      });
    try {
      const h = speak("Interrupted while unlocking.", { voice: "hr" });
      for (let i = 0; i < 50; i++) await Promise.resolve(); // fetch + decode done, now inside resume()
      h.cancel();
      unlock();
      await h.done;
      expect(createdSources).toHaveLength(0);
      expect(kk.utterances).toHaveLength(0);
    } finally {
      ctx.resume = realResume; // the context is a module singleton shared by every test
    }
  });

  it("the latch covers chatterbox too — it is about server engines, not one vendor", async () => {
    storage.setItem("pds_voice_engine", "chatterbox");
    const f = stubFetch(async () => ({ ok: false, status: 500 }));
    await speak("Studio server down.").done;
    expect(bodyOf(f).engine).toBe("chatterbox");
    expect(voiceDegraded()).toBe(true);
    await speak("Second line.").done;
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("on-device engines never touch the network, latched or not", async () => {
    storage.setItem("pds_voice_engine", "kokoro");
    const f = stubFetch(async () => buffered());
    const h = speak("Purely local.", { voice: "fence" });
    await expect(h.engineUsed).resolves.toBe("kokoro");
    await h.done;
    expect(f).not.toHaveBeenCalled();
    expect(voiceDegraded()).toBe(false);
  });

  it.each<[string, string | undefined, string | undefined]>([
    ["a persona key", "moderator", "moderator"],
    ["a legacy wav name", "Emily.wav", "Emily.wav"],
    ["a traversal attempt", "../../etc/passwd.wav", undefined],
    ["a path", "voices/Emily.wav", undefined],
    ["an empty string", "", undefined],
    ["whitespace", "   ", undefined],
    ["a script tag", "<script>.wav", undefined],
    ["an unknown key", "interviewer", undefined],
    ["a 200-char name", `${"a".repeat(200)}.wav`, undefined],
  ])("only a safe voice reaches the server: %s", async (_label, voice, expected) => {
    // A rejected request is a 400, and a 400 is silence plus a latched session.
    const f = stubFetch(async () => buffered());
    await speak("Voice check.", { voice }).done;
    expect(bodyOf(f).voice).toBe(expected);
  });

  it("tints the orb per utterance and clears it again, so a GD persona's colour never leaks", async () => {
    stubFetch(async () => buffered());
    await speak("A debater speaks.", { voice: "data", hue: [10, 20, 30] }).done;
    expect(viz.hues.at(-1)).toEqual([10, 20, 30]);
    await speak("The interviewer speaks.", { voice: "hr" }).done;
    expect(viz.hues.at(-1)).toBeNull();
  });

  it.each<[VoiceEngine, boolean]>([
    ["cloud", true],
    ["chatterbox", true],
    ["elevenlabs", true],
    ["kokoro", false],
    ["system", false],
  ])("isServerVoiceEngine(%s) === %s", (engine, expected) => {
    expect(isServerVoiceEngine(engine)).toBe(expected);
  });
});

// ═════════ 6. Streaming playback: problems never change the voice ══════════

describe("streamed playback — every retry stays on the SAME engine", () => {
  // The streaming player has three ways to give up: an unparseable header, a
  // format it cannot schedule, and a socket that dies. All three must retry the
  // SAME engine buffered, because the alternative — dropping to the fallback
  // voice — changes who is talking halfway through a sentence.

  it("plays a mono 16-bit stream gaplessly in one request", async () => {
    const f = stubFetch(async () => streamOf(wavPackets(6300, [9600, 3000])));
    const h = speak("Streamed cleanly.");
    await expect(h.engineUsed).resolves.toBe("cloud");
    await h.done;

    expect(f).toHaveBeenCalledTimes(1);
    expect(bodyOf(f).stream).toBe(true);
    expect(createdSources).toHaveLength(2);
    expect(totalScheduledSamples()).toBe(6300);
    // Packet 2 butts exactly against the end of packet 1 — no gap, no overlap.
    expect(createdSources[0].startedAt).toBeCloseTo(0.05);
    expect(createdSources[1].startedAt).toBeCloseTo(0.05 + 4800 / SR);
    expect(voiceDegraded()).toBe(false);
    expect(kk.utterances).toHaveLength(0);
  });

  it("streams a header split across packets, and a packet carrying header+audio together", async () => {
    const header = buildWav({ streaming: true });
    const pcm = pcmBytes(ramp(5000));
    const f = stubFetch(async () =>
      streamOf([
        header.subarray(0, 20),
        new Uint8Array([...header.subarray(20), ...pcm.subarray(0, 9600)]),
        pcm.subarray(9600),
      ]),
    );
    const h = speak("Split header.");
    await h.done;
    expect(f).toHaveBeenCalledTimes(1); // no buffered retry was needed
    expect(totalScheduledSamples()).toBe(5000);
  });

  it("does not lose the sample straddling two packets", async () => {
    // 9601 bytes: the 4801st sample is cut in half by the packet boundary.
    const f = stubFetch(async () => streamOf(wavPackets(6000, [9601])));
    await speak("Odd packet boundary.").done;
    expect(f).toHaveBeenCalledTimes(1);
    expect(totalScheduledSamples()).toBe(6000);
  });

  it.each<[string, { channels?: number; bits?: number }]>([
    ["stereo", { channels: 2 }],
    ["8-bit", { bits: 8 }],
    ["32-bit", { bits: 32 }],
  ])("a %s stream retries BUFFERED on the same engine rather than changing voice", async (_label, fmt) => {
    const f = stubFetch(async (_url, init) => {
      const stream = JSON.parse(String(init?.body)).stream as boolean;
      return stream ? streamOf(wavPackets(4800, [9600], fmt)) : buffered();
    });
    const h = speak("Exotic format.");
    await expect(h.engineUsed).resolves.toBe("cloud");
    await h.done;

    expect(f).toHaveBeenCalledTimes(2);
    expect(bodyOf(f, 0).stream).toBe(true);
    expect(bodyOf(f, 1).stream).toBe(false);
    expect(bodyOf(f, 1).engine).toBe(bodyOf(f, 0).engine); // SAME engine
    expect(voiceDegraded()).toBe(false);
    expect(kk.utterances).toHaveLength(0);
  });

  it.each<[string, () => Uint8Array[]]>([
    ["a body that is not a WAV at all", () => [new Uint8Array(ascii('{"error":"bad gateway"}'))]],
    ["a stream that ends mid-header", () => [buildWav({ streaming: true }).subarray(0, 30)]],
    ["a header with zero samples behind it", () => [buildWav({ streaming: true })]],
  ])("%s retries buffered on the same engine", async (_label, packets) => {
    const f = stubFetch(async (_url, init) =>
      JSON.parse(String(init?.body)).stream ? streamOf(packets()) : buffered(),
    );
    const h = speak("Bad stream.");
    await expect(h.engineUsed).resolves.toBe("cloud");
    await h.done;
    expect(f).toHaveBeenCalledTimes(2);
    expect(voiceDegraded()).toBe(false);
  });

  it("a socket that dies BEFORE any audio retries buffered; if that fails too, the floor speaks", async () => {
    const f = stubFetch(async (_url, init) =>
      JSON.parse(String(init?.body)).stream ? streamOf([], { failAt: 0 }) : ({ ok: false, status: 502 } as TtsResponse),
    );
    const h = speak("Died early.", { voice: "technical" });
    await expect(h.engineUsed).resolves.toBe("kokoro");
    await h.done;
    expect(f).toHaveBeenCalledTimes(2);
    expect(voiceDegraded()).toBe(true);
    expect(kk.utterances[0].voice).toBe(VOICE_CAST.kokoro.technical);
  });

  it("a socket that dies AFTER audio started keeps what is scheduled and does NOT degrade", async () => {
    // Half a sentence in the right voice beats a whole sentence that starts in
    // one voice and finishes in another.
    const f = stubFetch(async () => streamOf(wavPackets(4800, [9600]), { failAt: 2 }));
    const h = speak("Died mid-sentence.");
    await expect(h.engineUsed).resolves.toBe("cloud");
    await h.done;
    expect(f).toHaveBeenCalledTimes(1);
    expect(createdSources.length).toBeGreaterThan(0);
    expect(voiceDegraded()).toBe(false);
    expect(kk.utterances).toHaveLength(0);
  });

  it("cancel() mid-stream stops every scheduled source and never falls back", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = stubFetch(async () => streamOf(wavPackets(9600, [9600, 9600]), { gateAt: 2, gate }));
    const h = speak("Barge in on me.");
    // Wait until the first packet has actually been scheduled, then interrupt.
    for (let i = 0; i < 200 && createdSources.length === 0; i++) await Promise.resolve();
    expect(createdSources).toHaveLength(1);
    h.cancel();
    release();
    await h.done;

    expect(createdSources[0].stopped).toBe(true);
    expect(f).toHaveBeenCalledTimes(1); // no buffered retry after a deliberate stop
    expect(kk.utterances).toHaveLength(0);
    expect(voiceDegraded()).toBe(false);
    await expect(h.firstSyllableAt).resolves.toBeTypeOf("number"); // awaiters never hang
  });

  it("audio that cannot be decoded degrades rather than leaving the interviewer silent", async () => {
    failDecode = true;
    stubFetch(async () => buffered());
    const h = speak("Corrupt bytes.");
    await expect(h.engineUsed).resolves.toBe("kokoro");
    await h.done;
    expect(voiceDegraded()).toBe(true);
  });

  it("a locked audio output (autoplay policy) falls through to the floor instead of hanging", async () => {
    stubFetch(async () => buffered());
    if (ctxRef) ctxRef.state = "suspended"; // resume() cannot unlock it outside a gesture
    const h = speak("Never unlocked.");
    await expect(h.engineUsed).resolves.toBe("kokoro");
    await h.done;
  });
});

// ═══════════ 7. The floor voice: identity survives the fall ════════════════

describe("the floor voice — the fallback is still the same character", () => {
  // Falling back is a downgrade in fidelity. It must NOT be a downgrade in
  // identity: the GD moderator who drops to the on-device voice must drop to
  // the MODERATOR's on-device voice, or the room gains a seventh participant.

  it.each(VOICE_KEYS)("a degraded '%s' turn keeps that persona's on-device voice", async (key) => {
    stubFetch(async () => ({ ok: false, status: 500 }));
    await speak("A line from this persona.", { voice: key }).done;
    expect(kk.utterances).toHaveLength(1);
    expect(kk.utterances[0].voice).toBe(VOICE_CAST.kokoro[key]);
  });

  it("maps a legacy wav name to the right on-device voice when it falls back", async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));
    await speak("Legacy voice name.", { voice: "Axel.wav" }).done;
    expect(kk.utterances[0].voice).toBe(VOICE_CAST.kokoro.dominator);
  });

  it("strips studio speech tags before the floor speaks — Kokoro would read them aloud", async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));
    await speak("[chuckle] That is a fair point. [sigh] Let us move on.", { voice: "hr" }).done;
    const spoken = kk.utterances[0].chunks.join(" ");
    expect(spoken).not.toContain("chuckle");
    expect(spoken).not.toContain("[");
    expect(spoken).toContain("That is a fair point.");
  });

  it("HOLDS the line for a model that is still downloading rather than splitting it in two voices", async () => {
    // Speaking THIS sentence with the system voice and the next one with Kokoro
    // is the mid-reply switch. A one-off delay is the smaller flaw.
    kk.status = "loading";
    let release!: () => void;
    kk.gate = new Promise<void>((r) => (release = r));
    stubFetch(async () => ({ ok: false, status: 500 }));

    const h = speak("Wait for the real voice.", { voice: "hr" });
    await Promise.resolve();
    expect(kk.utterances).toHaveLength(0); // nothing spoken yet — the line is held
    kk.status = "ready";
    release();
    await h.done;
    expect(kk.utterances).toHaveLength(1);
    await expect(h.engineUsed).resolves.toBe("kokoro");
    // Bounded, so it can never hang forever. 20 s, not the original 8: the
    // preroll now holds Start until the model is ready, so this hold is only
    // reached on a mid-round reload — and a real-browser run measured the
    // download at ~50 s, so 8 s expired and handed the greeting to the system
    // voice every first visit.
    expect(kk.readyWaits[0]).toBe(20_000);
  });

  it("a model that never arrives falls through to the system voice and says so", async () => {
    kk.status = "loading";
    kk.readyResult = false;
    stubFetch(async () => ({ ok: false, status: 500 }));
    const h = speak("The model never came.");
    await expect(h.engineUsed).resolves.toBe("system");
    await h.done;
    expect(kk.utterances).toHaveLength(0);
  });

  it("goes straight to the system voice when the model has already failed (no 8s hold)", async () => {
    kk.status = "failed";
    stubFetch(async () => ({ ok: false, status: 500 }));
    const h = speak("Nothing on device.");
    await expect(h.engineUsed).resolves.toBe("system");
    await h.done;
    expect(kk.readyWaits).toHaveLength(0);
  });

  it("cancel() during the hold still cancels whatever eventually starts", async () => {
    // The candidate leaves the room while the model is downloading. Without
    // this, the utterance starts speaking into an empty page seconds later.
    kk.status = "loading";
    let release!: () => void;
    kk.gate = new Promise<void>((r) => (release = r));
    stubFetch(async () => ({ ok: false, status: 500 }));

    const h = speak("Abandoned mid-download.", { voice: "hr" });
    await Promise.resolve();
    h.cancel();
    kk.status = "ready";
    release();
    await h.done;

    expect(kk.utterances).toHaveLength(1);
    expect(kk.utterances[0].cancelled).toBe(true);
    await expect(h.firstSyllableAt).resolves.toBeTypeOf("number");
    await expect(h.engineUsed).resolves.toBeTypeOf("string"); // never hangs an awaiter
  });

  it("cancel() during the hold resolves `done` NOW, not when the download settles", async () => {
    // Both hooks `await handle.done` straight after a barge-in cancel() before
    // handing the floor to the candidate. A done that waited for the 8s
    // kokoroReady() hold froze the interview for that long.
    kk.status = "loading";
    let release!: () => void;
    kk.gate = new Promise<void>((r) => (release = r));
    stubFetch(async () => ({ ok: false, status: 500 }));

    const h = speak("Barged into mid-download.", { voice: "hr" });
    await Promise.resolve();
    h.cancel();
    let resolved = false;
    void h.done.then(() => (resolved = true));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(resolved).toBe(true); // the gate is still closed

    kk.status = "ready";
    release();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(kk.utterances).toHaveLength(1);
    expect(kk.utterances[0].cancelled).toBe(true); // whatever started late is still killed
  });
});

// ═══════════════ 8. The two-draw rule under adversarial timing ═════════════

// The queue is tested against a fully controllable fake tts so that draw
// boundaries, playback starts and preparation can be interleaved by hand —
// the races here are microseconds wide in production.

interface FakeDraw {
  text: string;
  kind: "speak" | "play";
  cancels: number;
  startSpeaking: () => void;
  finish: () => void;
}

const qm = {
  speaks: [] as string[],
  prepares: [] as string[],
  plays: [] as string[],
  prepareCancels: [] as string[],
  draws: [] as FakeDraw[],
  /** When true, a draw only starts/ends when the test says so. */
  manual: false,
  /** When true, prepared audio is not ready until released. */
  holdPrepare: false,
  releasePrepare: [] as (() => void)[],
  reset() {
    qm.speaks = [];
    qm.prepares = [];
    qm.plays = [];
    qm.prepareCancels = [];
    qm.draws = [];
    qm.manual = false;
    qm.holdPrepare = false;
    qm.releasePrepare = [];
  },
};

function fakeDraw(text: string, kind: "speak" | "play"): SpeakHandle {
  let resolveFirst!: (t: number) => void;
  const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const rec: FakeDraw = {
    text,
    kind,
    cancels: 0,
    startSpeaking: () => resolveFirst(Date.now()),
    finish: () => resolveDone(),
  };
  qm.draws.push(rec);
  const handle: SpeakHandle = {
    done,
    firstSyllableAt,
    engineUsed: Promise.resolve("cloud"),
    cancel() {
      rec.cancels++;
      resolveFirst(Date.now());
      resolveDone();
    },
  };
  if (!qm.manual) {
    rec.startSpeaking();
    rec.finish();
  }
  return handle;
}

/** Spin microtasks until `cond` holds — no timers, so a pending waitForClose
 * stays pending and the race being tested is the one that runs. */
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error(`condition never held: ${label}`);
}
const flush = async (turns = 30) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

describe("speech queue — the two-draw rule under adversarial timing", () => {
  // A turn costs at most two synthesis draws, and every one of the ways a turn
  // can be interrupted — closed early, closed late, cancelled between draws,
  // cancelled while draw 2 is still being prepared — must leave the queue
  // resolved, silent, and with nothing scheduled behind it.

  let createSpeechQueue: typeof import("@/lib/speech-queue").createSpeechQueue;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("@/lib/tts", () => ({
      getVoiceEngine: () => "cloud",
      isServerVoiceEngine: () => true,
      speak: (text: string) => {
        qm.speaks.push(text);
        return fakeDraw(text, "speak");
      },
      prepareSpeak: (text: string) => {
        qm.prepares.push(text);
        const ready = qm.holdPrepare
          ? new Promise<void>((r) => qm.releasePrepare.push(r))
          : Promise.resolve();
        return {
          ready,
          play: () => {
            qm.plays.push(text);
            return fakeDraw(text, "play");
          },
          cancel: () => void qm.prepareCancels.push(text),
        };
      },
    }));
    ({ createSpeechQueue } = await import("@/lib/speech-queue"));
  });

  beforeEach(() => qm.reset());
  afterEach(() => vi.useRealTimers());

  it("end() with nothing pushed settles at once, and a later push is refused outright", async () => {
    const q = createSpeechQueue({ voice: "hr" });
    q.end();
    q.push("Arrived after the door closed.");
    await q.done;
    expect(q.size).toBe(0); // refused, not queued-and-forgotten
    expect(qm.speaks).toEqual([]);
    await expect(q.firstSyllableAt).resolves.toBeTypeOf("number");
  });

  it("end() during draw 1 prepares draw 2 while draw 1 is still audible", async () => {
    qm.manual = true;
    const q = createSpeechQueue({ voice: "hr" });
    q.push("The opening sentence.");
    await until(() => qm.draws.length === 1, "draw 1 created");
    qm.draws[0].startSpeaking();

    q.push("The second sentence.");
    q.push("And a third one.");
    q.end();
    // Draw 1 has NOT finished — preparation must already be under way, or the
    // hand-off between draws is a synthesis gap the candidate hears.
    await until(() => qm.prepares.length === 1, "draw 2 prepared during draw 1");
    expect(qm.prepares[0]).toBe("The second sentence. And a third one.");
    expect(qm.plays).toEqual([]);

    qm.draws[0].finish();
    await until(() => qm.draws.length === 2, "draw 2 created");
    qm.draws[1].startSpeaking();
    qm.draws[1].finish();
    await q.done;
    expect(q.draws).toBe(2);
  });

  it("a sentence that lands while draw 1 is still playing joins draw 2 instead of becoming draw 3", async () => {
    qm.manual = true;
    const q = createSpeechQueue({ voice: "hr" });
    q.push("Opening line here.");
    await until(() => qm.draws.length === 1, "draw 1");
    qm.draws[0].startSpeaking();
    q.push("Second line here.");
    q.push("Third line here.");
    q.end();
    await until(() => qm.prepares.length === 1, "prepared");
    qm.draws[0].finish();
    await until(() => qm.draws.length === 2, "draw 2");
    qm.draws[1].startSpeaking();
    qm.draws[1].finish();
    await q.done;
    expect(q.draws).toBe(2);
    expect(qm.speaks).toEqual(["Opening line here."]);
    expect(qm.plays).toEqual(["Second line here. Third line here."]);
  });

  it("draw 2 waits for the turn to close, but not forever (the 1.5s bound)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    qm.manual = true;
    const q = createSpeechQueue({ voice: "hr" });
    q.push("The model is slow today.");
    await until(() => qm.draws.length === 1, "draw 1");
    qm.draws[0].startSpeaking();
    q.push("The remainder arrives late.");

    await vi.advanceTimersByTimeAsync(1_400);
    expect(qm.prepares).toEqual([]); // still hoping the turn closes cleanly
    await vi.advanceTimersByTimeAsync(200);
    expect(qm.prepares).toEqual(["The remainder arrives late."]); // bound hit → speak what we have

    qm.draws[0].finish();
    await until(() => qm.draws.length === 2, "draw 2");
    qm.draws[1].startSpeaking();
    qm.draws[1].finish();
    q.end();
    await q.done;
    expect(q.draws).toBe(2);
  });

  it("sentences arriving after draw 2 was formed become ONE tail draw, not one per sentence", async () => {
    // A slow model can reopen the turn after the close bound already expired.
    // The tail must be gathered into a single utterance: reverting to
    // per-sentence draws here would reintroduce the very bug the queue exists
    // to prevent, at the end of every slow turn.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    qm.manual = true;
    const q = createSpeechQueue({ voice: "hr" });
    q.push("First sentence of the turn.");
    q.push("Second sentence of the turn.");
    await until(() => qm.draws.length === 1, "draw 1");
    qm.draws[0].startSpeaking();

    await vi.advanceTimersByTimeAsync(1_600); // the turn never closed — the bound forms draw 2
    expect(qm.prepares).toEqual(["Second sentence of the turn."]);

    qm.draws[0].finish();
    await until(() => qm.draws.length === 2, "draw 2 playing");
    qm.draws[1].startSpeaking();
    q.push("A late third sentence.");
    q.push("And a late fourth.");
    qm.draws[1].finish();

    await until(() => qm.draws.length === 3, "tail draw");
    qm.draws[2].startSpeaking();
    qm.draws[2].finish();
    q.end();
    await q.done;

    expect(q.draws).toBe(3); // two late sentences cost ONE extra draw, not two
    expect(qm.speaks).toEqual(["First sentence of the turn.", "A late third sentence. And a late fourth."]);
  });

  it("cancel() after draw 2 is prepared but before it plays never plays the prepared audio", async () => {
    qm.manual = true;
    const q = createSpeechQueue({ voice: "hr" });
    q.push("Sentence one.");
    q.push("Sentence two.");
    q.end();
    await until(() => qm.prepares.length === 1, "prepared");
    qm.draws[0].startSpeaking(); // draw 1 audible, draw 2 fully prepared behind it

    q.cancel();
    await q.done;
    expect(qm.prepareCancels).toContain("Sentence two."); // the decoded buffer is released
    expect(qm.plays).toEqual([]);
    expect(q.draws).toBe(1);
  });

  // REGRESSION: the driver used to settle as soon as it had spoken everything it
  // currently held, WITHOUT waiting for end(). On a turn whose opening sentence
  // finished playing inside the 1.5s close bound, `done` resolved while the turn
  // was still open — and every sentence the model wrote after that was accepted
  // by push() (q.size grew, so the caller was told it was queued) and then never
  // spoken. streamTurn() pushes sentences as they close and only calls end()
  // when the stream finishes, so any token-stream stall behind a short opening
  // sentence silently truncated the reply to that one sentence while the caption
  // showed the whole paragraph.
  //
  // The contract end()'s own docstring states: "done resolves once the LAST one
  // ends" — so the queue now stays open until the caller closes it.
  it("speaks a sentence pushed after a long stall instead of dropping it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    qm.manual = true;
    const q = createSpeechQueue({ voice: "hr" });
    q.push("A short opening line.");
    await until(() => qm.draws.length === 1, "draw 1");
    qm.draws[0].startSpeaking();
    qm.draws[0].finish(); // short sentence: its audio ends before the close bound
    await vi.advanceTimersByTimeAsync(1_600); // the model stalls past CLOSE_WAIT_MS

    q.push("The rest of the answer, written slowly."); // the model was just slow
    expect(q.size).toBe(2); // push() accepted it — the turn is still open
    q.end();

    await until(() => qm.draws.length === 2, "draw 2 after the stall");
    qm.draws[1].startSpeaking();
    qm.draws[1].finish();
    await q.done;

    expect(qm.speaks).toContain("The rest of the answer, written slowly.");
    expect(q.draws).toBe(2);
  });

  it("does not resolve done() before end() is called", async () => {
    // The invariant behind the bug above, asserted directly.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    qm.manual = true;
    const q = createSpeechQueue({ voice: "hr" });
    q.push("The only sentence so far.");
    await until(() => qm.draws.length === 1, "draw 1");
    qm.draws[0].startSpeaking();
    qm.draws[0].finish();
    await vi.advanceTimersByTimeAsync(5_000); // far past the close bound

    let resolved = false;
    void q.done.then(() => (resolved = true));
    for (let i = 0; i < 50; i++) await Promise.resolve(); // drain microtasks
    expect(resolved).toBe(false); // still open — end() has not been called

    q.end();
    await q.done;
    expect(resolved).toBe(true);
  });

  it("cancel() while draw 2 is still being PREPARED releases it and resolves", async () => {
    qm.manual = true;
    qm.holdPrepare = true;
    const q = createSpeechQueue({ voice: "hr" });
    q.push("Sentence one.");
    q.push("Sentence two.");
    q.end();
    await until(() => qm.prepares.length === 1, "prepared");
    qm.draws[0].startSpeaking();

    q.cancel(); // barge-in with draw 1 mid-word and draw 2 mid-synthesis
    qm.releasePrepare.forEach((r) => r());
    await q.done;

    expect(qm.draws[0].cancels).toBe(1);
    expect(qm.prepareCancels).toContain("Sentence two.");
    expect(qm.plays).toEqual([]);
  });

  it("cancel() during draw 1 kills that utterance and never starts draw 2", async () => {
    qm.manual = true;
    const q = createSpeechQueue({ voice: "hr" });
    q.push("Interrupt me here.");
    q.push("This must stay unsaid.");
    await until(() => qm.draws.length === 1, "draw 1");
    qm.draws[0].startSpeaking();
    q.cancel();
    await q.done;
    expect(qm.draws[0].cancels).toBe(1);
    expect(qm.plays).toEqual([]);
    expect(qm.speaks).toEqual(["Interrupt me here."]);
  });

  it("cancel() and push() after the turn is over are no-ops, not crashes", async () => {
    const q = createSpeechQueue({ voice: "hr" });
    q.push("The only sentence.");
    q.end();
    await q.done;
    q.cancel();
    q.cancel();
    q.push("Too late.");
    await q.done; // still resolved, no re-entry
    expect(qm.speaks).toEqual(["The only sentence."]);
  });

  it("cancel() before the gate resolves speaks nothing at all", async () => {
    // The ack is still playing when the candidate barges in. Releasing the gate
    // afterwards must not start a reply nobody is waiting for any more.
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    const q = createSpeechQueue({ voice: "hr", gate });
    q.push("Gated sentence one.");
    q.push("Gated sentence two.");
    q.end();
    q.cancel();
    openGate();
    await q.done;
    expect(qm.speaks).toEqual([]);
    expect(qm.prepares).toEqual([]);
  });

  it("a REJECTED gate does not silence the turn", async () => {
    // The ack handle failing is not a reason for the interviewer to say nothing.
    const q = createSpeechQueue({ voice: "hr", gate: Promise.reject(new Error("ack blew up")) });
    q.push("The reply still happens.");
    q.end();
    await q.done;
    expect(qm.speaks).toEqual(["The reply still happens."]);
  });

  it("captions follow real playback: onSpeaking fires when audio starts, not when speak() is called", async () => {
    qm.manual = true;
    const seen: [string, number][] = [];
    const q = createSpeechQueue({ voice: "hr", onSpeaking: (t, i) => void seen.push([t, i]) });
    q.push("Caption one here.");
    q.push("Caption two here.");
    q.end();
    await until(() => qm.draws.length === 1, "draw 1");
    await flush();
    expect(seen).toEqual([]); // synthesis started, but nothing is audible yet

    qm.draws[0].startSpeaking();
    await flush();
    expect(seen).toEqual([["Caption one here.", 0]]);

    qm.draws[0].finish();
    await until(() => qm.draws.length === 2, "draw 2");
    qm.draws[1].startSpeaking();
    qm.draws[1].finish();
    await q.done;
    expect(seen).toEqual([
      ["Caption one here.", 0],
      ["Caption two here.", 1],
    ]);
  });

  it("a draw cancelled before it is audible is never captioned", async () => {
    // Barge-in must not leave a sentence on screen that the candidate never
    // heard — the caption is a record of what was SAID.
    qm.manual = true;
    const seen: string[] = [];
    const q = createSpeechQueue({ voice: "hr", onSpeaking: (t) => void seen.push(t) });
    q.push("Never actually heard.");
    q.end();
    await until(() => qm.draws.length === 1, "draw 1");
    q.cancel();
    await q.done;
    await flush();
    expect(seen).toEqual([]);
  });

  it.each<[string, string[], string]>([
    ["padded sentences", ["  Leading and trailing.  ", "\n\tSecond one.\n"], "Second one."],
    ["unicode", ["Начало предложения.", "Ünïcödé — ça va, naïve? 你好。"], "Ünïcödé — ça va, naïve? 你好。"],
    ["a very long sentence", ["Opening line.", `${"very ".repeat(400)}long.`], `${"very ".repeat(400)}long.`],
    ["injection-looking text", ["Opening line.", '"; DROP TABLE turns; --<script>alert(1)</script>'], '"; DROP TABLE turns; --<script>alert(1)</script>'],
  ])("draw 2 joins %s with exactly one space and no other edits", async (_label, sentences, expectedTail) => {
    const q = createSpeechQueue({ voice: "hr" });
    for (const s of sentences) q.push(s);
    q.end();
    await q.done;
    expect(qm.plays).toHaveLength(1);
    expect(qm.plays[0]).toBe(expectedTail);
    expect(qm.plays[0]).not.toMatch(/ {2,}|^\s|\s$/);
  });

  it.each([1, 2, 3, 7, 25, 100])("a %i-sentence turn still costs at most two draws", async (n) => {
    const q = createSpeechQueue({ voice: "hr" });
    for (let i = 0; i < n; i++) q.push(`Sentence number ${i} of the reply.`);
    q.push("   "); // whitespace never becomes a draw of its own
    q.end();
    await q.done;
    expect(q.size).toBe(n);
    expect(q.draws).toBe(n === 1 ? 1 : 2);
    expect(qm.speaks).toHaveLength(1);
  });
});
