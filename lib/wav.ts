// Pure helpers for the streaming WAV playback path: header parsing, PCM16
// decoding, and gapless-scheduler timing math. No DOM and no Web Audio here —
// everything is unit-testable in node (test/wav.test.ts).

export interface WavFormat {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  /** Byte offset (into the parsed bytes) where PCM data begins. */
  dataOffset: number;
}

// Streaming servers write 0xFFFFFFFF for RIFF/data sizes (length unknown upfront).
const UNBOUNDED = 0xffffffff;

function tag(bytes: Uint8Array, off: number): string {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

/**
 * Parse a (possibly streaming) RIFF/WAVE header from the first bytes of a
 * response. Returns null while more bytes are needed; throws when the bytes
 * can never be a streamable PCM WAV. Extra chunks (LIST, fact, ...) between
 * "fmt " and "data" are skipped; only "data" may have an unbounded size.
 */
export function parseWavHeader(bytes: Uint8Array): WavFormat | null {
  if (bytes.length < 12) return null;
  if (tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") throw new Error("not_wav");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: Omit<WavFormat, "dataOffset"> | null = null;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(bytes, off);
    const size = dv.getUint32(off + 4, true);
    if (id === "data") {
      if (!fmt) throw new Error("wav_data_before_fmt");
      return { ...fmt, dataOffset: off + 8 };
    }
    if (size === UNBOUNDED) throw new Error("wav_unbounded_chunk");
    if (id === "fmt ") {
      if (off + 8 + 16 > bytes.length) return null; // fmt payload not fully arrived
      const audioFormat = dv.getUint16(off + 8, true);
      if (audioFormat !== 1) throw new Error("wav_not_pcm");
      fmt = {
        numChannels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bitsPerSample: dv.getUint16(off + 22, true),
      };
    }
    off += 8 + size + (size % 2); // RIFF chunks are word-aligned
  }
  return null;
}

/** Convert little-endian PCM16 bytes to Float32 samples in [-1, 1). An odd
 * trailing byte (a sample split across network chunks) comes back as
 * `remainder` for the caller to prepend to the next chunk. */
export function pcm16ToFloat32(bytes: Uint8Array): {
  samples: Float32Array<ArrayBuffer>;
  remainder: Uint8Array<ArrayBuffer>;
} {
  const even = bytes.length & ~1;
  const samples = new Float32Array(even / 2);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, even);
  for (let i = 0; i < samples.length; i++) samples[i] = dv.getInt16(i * 2, true) / 32768;
  return { samples, remainder: bytes.slice(even) };
}

/** When the next gapless buffer should start: never in the past (a start time
 * before `now` clips the chunk's head), never before already-queued audio ends. */
export function nextChunkStartTime(now: number, scheduledUntil: number, leadInSec = 0.03): number {
  return Math.max(now + leadInSec, scheduledUntil);
}

export function concatBytes(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
