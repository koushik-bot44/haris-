// Pure PCM ⇄ WAV framing helpers shared by the server TTS engines and the
// client player. Cloud voices (ElevenLabs, OpenAI, Deepgram, Gemini) return
// RAW little-endian PCM16 — no container. The client's gapless streaming
// player (lib/tts.ts playStreaming + lib/wav.ts) already understands a
// streaming WAV whose RIFF/data sizes are 0xFFFFFFFF, so the cheapest way to
// make every engine look the same is to prepend that header server-side and
// pipe the PCM bytes straight through. No decoding, no buffering, no DOM.

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** Streaming servers write 0xFFFFFFFF when the length is unknown upfront. */
export const WAV_UNBOUNDED = 0xffffffff;

function writeTag(view: DataView, off: number, tag: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(off + i, tag.charCodeAt(i));
}

/** A 44-byte RIFF/WAVE header. `dataBytes` null → streaming header (sizes
 * unbounded); a number → a well-formed finite WAV for decodeAudioData. */
export function wavHeader(fmt: PcmFormat, dataBytes: number | null = null): Uint8Array<ArrayBuffer> {
  const { sampleRate, channels, bitsPerSample } = fmt;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  writeTag(v, 0, "RIFF");
  v.setUint32(4, dataBytes === null ? WAV_UNBOUNDED : 36 + dataBytes, true);
  writeTag(v, 8, "WAVE");
  writeTag(v, 12, "fmt ");
  v.setUint32(16, 16, true); // PCM fmt chunk size
  v.setUint16(20, 1, true); // audioFormat = PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  writeTag(v, 36, "data");
  v.setUint32(40, dataBytes === null ? WAV_UNBOUNDED : dataBytes, true);
  return new Uint8Array(buf);
}

/** Wrap a raw-PCM byte stream as a streaming WAV: the header goes out first,
 * then every chunk passes through untouched. The returned stream cancels the
 * source when the consumer goes away (client disconnect → upstream abort). */
export function pcmToWavStream(
  pcm: ReadableStream<Uint8Array>,
  fmt: PcmFormat,
): ReadableStream<Uint8Array> {
  const reader = pcm.getReader();
  let headerSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(wavHeader(fmt, null));
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value && value.length) controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** One finite WAV from a complete PCM buffer (for engines that return the
 * whole clip at once, e.g. base64 from Gemini). */
export function pcmToWav(pcm: Uint8Array, fmt: PcmFormat): Uint8Array<ArrayBuffer> {
  const header = wavHeader(fmt, pcm.length);
  const out = new Uint8Array(header.length + pcm.length);
  out.set(header, 0);
  out.set(pcm, header.length);
  return out;
}

/** Base64 → bytes without Buffer, so it works in both runtimes. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  if (typeof atob === "function") {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node without atob (very old) — Buffer path.
  const nodeBuf = (globalThis as unknown as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (!nodeBuf) throw new Error("no_base64_decoder");
  const b = nodeBuf.from(clean, "base64");
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

/** Bytes → base64 (mirror of base64ToBytes; used by the STT client to ship
 * small PCM segments inside JSON when multipart is unavailable). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(bin);
  }
  const nodeBuf = (globalThis as unknown as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } })
    .Buffer;
  if (!nodeBuf) throw new Error("no_base64_encoder");
  return nodeBuf.from(bytes).toString("base64");
}

/** Float32 [-1,1] samples → little-endian PCM16 bytes (mic capture → STT). */
export function float32ToPcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}
