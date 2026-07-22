import { describe, expect, it } from "vitest";
import { concatBytes, nextChunkStartTime, parseWavHeader, pcm16ToFloat32 } from "@/lib/wav";

// ——— builders ———

function bytesOf(...parts: (string | number[] | { u16: number } | { u32: number })[]): number[] {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) out.push(ch.charCodeAt(0));
    else if (Array.isArray(p)) out.push(...p);
    else if ("u16" in p) out.push(p.u16 & 0xff, (p.u16 >>> 8) & 0xff);
    else out.push(p.u32 & 0xff, (p.u32 >>> 8) & 0xff, (p.u32 >>> 16) & 0xff, (p.u32 >>> 24) & 0xff);
  }
  return out;
}

function buildWav(opts: {
  sampleRate?: number;
  channels?: number;
  bits?: number;
  format?: number;
  streaming?: boolean;
  extra?: { id: string; payload: number[]; size?: number }[];
  data?: number[];
  dataBeforeFmt?: boolean;
} = {}): Uint8Array {
  const {
    sampleRate = 24000,
    channels = 1,
    bits = 16,
    format = 1,
    streaming = false,
    extra = [],
    data = [],
    dataBeforeFmt = false,
  } = opts;
  const fmt = bytesOf(
    "fmt ",
    { u32: 16 },
    { u16: format },
    { u16: channels },
    { u32: sampleRate },
    { u32: (sampleRate * channels * bits) / 8 },
    { u16: (channels * bits) / 8 },
    { u16: bits },
  );
  const dataChunk = bytesOf("data", { u32: streaming ? 0xffffffff : data.length }, data);
  const extras = extra.flatMap((e) =>
    bytesOf(e.id, { u32: e.size ?? e.payload.length }, e.payload, e.payload.length % 2 ? [0] : []),
  );
  const body = dataBeforeFmt ? [...dataChunk, ...fmt] : [...fmt, ...extras, ...dataChunk];
  return new Uint8Array(
    bytesOf("RIFF", { u32: streaming ? 0xffffffff : 4 + body.length }, "WAVE", body),
  );
}

function pcm16Bytes(samples: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2);
  const dv = new DataView(out.buffer);
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true));
  return out;
}

/** Re-view bytes at a non-zero byteOffset of a larger buffer — network chunks
 * arrive as views, and DataView math must honor the offset. */
function unaligned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(bytes.length + 3);
  buf.set(bytes, 3);
  return buf.subarray(3);
}

// ——— header parsing ———

describe("parseWavHeader", () => {
  it("parses the standard 44-byte PCM header", () => {
    const h = parseWavHeader(buildWav({ data: [0, 0, 0, 0] }));
    expect(h).toEqual({ sampleRate: 24000, numChannels: 1, bitsPerSample: 16, dataOffset: 44 });
  });

  it("accepts streaming headers (0xFFFFFFFF RIFF/data sizes — Chatterbox writes these)", () => {
    const h = parseWavHeader(buildWav({ streaming: true }));
    expect(h).toEqual({ sampleRate: 24000, numChannels: 1, bitsPerSample: 16, dataOffset: 44 });
  });

  it("passes the sample rate through untouched", () => {
    for (const sr of [8000, 22050, 24000, 44100, 48000]) {
      expect(parseWavHeader(buildWav({ sampleRate: sr }))?.sampleRate).toBe(sr);
    }
  });

  it("reports channel count and bit depth (caller decides what it can play)", () => {
    const h = parseWavHeader(buildWav({ channels: 2, bits: 24 }));
    expect(h?.numChannels).toBe(2);
    expect(h?.bitsPerSample).toBe(24);
  });

  it("skips extra chunks between fmt and data", () => {
    const h = parseWavHeader(buildWav({ extra: [{ id: "LIST", payload: new Array(26).fill(7) }] }));
    expect(h?.dataOffset).toBe(44 + 8 + 26);
  });

  it("word-aligns odd-sized extra chunks (RIFF pads to even)", () => {
    const h = parseWavHeader(buildWav({ extra: [{ id: "fact", payload: new Array(7).fill(1) }] }));
    expect(h?.dataOffset).toBe(44 + 8 + 7 + 1);
  });

  it("returns null while more bytes are needed (streaming trickle)", () => {
    const full = buildWav({ streaming: true });
    for (const len of [0, 4, 11, 12, 20, 35, 43]) {
      expect(parseWavHeader(full.slice(0, len))).toBeNull();
    }
    expect(parseWavHeader(full.slice(0, 44))).not.toBeNull();
  });

  it("throws on bytes that can never be a WAV", () => {
    expect(() => parseWavHeader(new Uint8Array(bytesOf("OggSxxxxxxxxxxxx")))).toThrow("not_wav");
    expect(() => parseWavHeader(new Uint8Array(bytesOf("RIFF", { u32: 0 }, "AVI xxxx")))).toThrow("not_wav");
  });

  it("throws on non-PCM formats (IEEE float = 3)", () => {
    expect(() => parseWavHeader(buildWav({ format: 3 }))).toThrow("wav_not_pcm");
  });

  it("throws when data precedes fmt", () => {
    expect(() => parseWavHeader(buildWav({ dataBeforeFmt: true, streaming: true }))).toThrow(
      "wav_data_before_fmt",
    );
  });

  it("throws on an unbounded NON-data chunk (would seek forever)", () => {
    expect(() =>
      parseWavHeader(buildWav({ extra: [{ id: "LIST", payload: [], size: 0xffffffff }] })),
    ).toThrow("wav_unbounded_chunk");
  });

  it("honors views at a non-zero byteOffset", () => {
    const h = parseWavHeader(unaligned(buildWav({ sampleRate: 44100 })));
    expect(h?.sampleRate).toBe(44100);
    expect(h?.dataOffset).toBe(44);
  });
});

// ——— PCM16 → Float32 ———

describe("pcm16ToFloat32", () => {
  it("maps the int16 range onto [-1, 1)", () => {
    const { samples } = pcm16ToFloat32(pcm16Bytes([0, 32767, -32768, -1, 16384]));
    expect(Array.from(samples)).toEqual([0, 32767 / 32768, -1, -1 / 32768, 0.5]);
  });

  it("returns an odd trailing byte as remainder instead of a garbage sample", () => {
    const bytes = pcm16Bytes([1000, -1000]);
    const cut = concatBytes(bytes, new Uint8Array([0x2c]));
    const { samples, remainder } = pcm16ToFloat32(cut);
    expect(samples.length).toBe(2);
    expect(Array.from(remainder)).toEqual([0x2c]);
  });

  it("reassembles a sample split across network chunks via the remainder", () => {
    const full = pcm16Bytes([1000, -1000, 500]);
    const first = pcm16ToFloat32(full.slice(0, 3)); // splits sample #2 mid-bytes
    const second = pcm16ToFloat32(concatBytes(first.remainder, full.slice(3)));
    expect(Array.from(first.samples)).toEqual([1000 / 32768]);
    expect(Array.from(second.samples)).toEqual([-1000 / 32768, 500 / 32768]);
    expect(second.remainder.length).toBe(0);
  });

  it("handles empty input", () => {
    const { samples, remainder } = pcm16ToFloat32(new Uint8Array(0));
    expect(samples.length).toBe(0);
    expect(remainder.length).toBe(0);
  });

  it("honors views at a non-zero byteOffset", () => {
    const { samples } = pcm16ToFloat32(unaligned(pcm16Bytes([-32768, 32767])));
    expect(Array.from(samples)).toEqual([-1, 32767 / 32768]);
  });
});

// ——— gapless scheduler timing ———

describe("nextChunkStartTime", () => {
  it("starts the first chunk just ahead of now (never in the past)", () => {
    expect(nextChunkStartTime(10, 0)).toBeCloseTo(10.03);
  });

  it("butts the next chunk against queued audio when ahead (gapless)", () => {
    expect(nextChunkStartTime(10, 14.2)).toBe(14.2);
  });

  it("re-anchors after an underrun (queue drained while synthesizing)", () => {
    expect(nextChunkStartTime(20, 14.2)).toBeCloseTo(20.03);
  });

  it("respects a custom lead-in", () => {
    expect(nextChunkStartTime(10, 0, 0.1)).toBeCloseTo(10.1);
    expect(nextChunkStartTime(10, 10.05, 0.1)).toBeCloseTo(10.1);
  });
});

// ——— byte concat ———

describe("concatBytes", () => {
  it("concatenates and short-circuits empty sides", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3]);
    expect(Array.from(concatBytes(a, b))).toEqual([1, 2, 3]);
    expect(concatBytes(a, new Uint8Array(0))).toBe(a);
    expect(concatBytes(new Uint8Array(0), b)).toBe(b);
  });
});
