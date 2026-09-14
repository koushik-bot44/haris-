import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, float32ToPcm16, pcmToWav, pcmToWavStream, wavHeader, WAV_UNBOUNDED } from "@/lib/pcm-wav";
import { parseWavHeader, pcm16ToFloat32 } from "@/lib/wav";

const FMT = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 };

describe("wavHeader", () => {
  it("writes a streaming header the client parser accepts", () => {
    const h = wavHeader(FMT, null);
    expect(h.length).toBe(44);
    const parsed = parseWavHeader(h);
    expect(parsed).toEqual({ sampleRate: 24_000, numChannels: 1, bitsPerSample: 16, dataOffset: 44 });
    const dv = new DataView(h.buffer);
    expect(dv.getUint32(4, true)).toBe(WAV_UNBOUNDED);
    expect(dv.getUint32(40, true)).toBe(WAV_UNBOUNDED);
  });

  it("writes correct finite sizes", () => {
    const h = wavHeader(FMT, 1000);
    const dv = new DataView(h.buffer);
    expect(dv.getUint32(4, true)).toBe(36 + 1000);
    expect(dv.getUint32(40, true)).toBe(1000);
    expect(dv.getUint32(28, true)).toBe(48_000); // byte rate
    expect(dv.getUint16(32, true)).toBe(2); // block align
  });
});

describe("pcmToWav / pcmToWavStream", () => {
  it("pcmToWav produces header + payload that round-trips", () => {
    const pcm = float32ToPcm16(new Float32Array([0, 0.5, -0.5, 1, -1]));
    const wav = pcmToWav(pcm, FMT);
    const header = parseWavHeader(wav)!;
    const { samples } = pcm16ToFloat32(wav.subarray(header.dataOffset));
    expect(Array.from(samples).map((s) => Math.round(s * 100) / 100)).toEqual([0, 0.5, -0.5, 1, -1]);
  });

  it("pcmToWavStream emits the header first, then every chunk untouched", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    });
    const out = new Uint8Array(await new Response(pcmToWavStream(src, FMT)).arrayBuffer());
    expect(out.length).toBe(44 + 5);
    expect(parseWavHeader(out)?.dataOffset).toBe(44);
    expect(Array.from(out.subarray(44))).toEqual([1, 2, 3, 4, 5]);
  });

  it("cancelling the wrapped stream cancels the source", async () => {
    let cancelled = false;
    const src = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const wrapped = pcmToWavStream(src, FMT);
    const reader = wrapped.getReader();
    const first = await reader.read();
    expect(first.value?.length).toBe(44);
    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});

describe("base64 and PCM helpers", () => {
  it("base64 round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it("float32ToPcm16 clamps and scales", () => {
    const pcm = float32ToPcm16(new Float32Array([2, -2, 0]));
    const dv = new DataView(pcm.buffer);
    expect(dv.getInt16(0, true)).toBe(32767);
    expect(dv.getInt16(2, true)).toBe(-32768);
    expect(dv.getInt16(4, true)).toBe(0);
  });
});
