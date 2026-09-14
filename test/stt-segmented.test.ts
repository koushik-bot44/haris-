import { describe, expect, it } from "vitest";
import { CaptureBuffer, downsample, looksLikeHallucination, STT_TARGET_RATE } from "@/lib/stt-segmented";

// The VAD names segment boundaries in wall-clock time; the audio is a sample
// buffer filled by a main-thread ScriptProcessor. Everything here is about the
// join between those two, because the main thread is exactly where React
// renders, Monaco loads and SSE is parsed — blocks arrive late and sometimes
// never arrive at all, and the old `(t - start) * rate` arithmetic believed
// otherwise. These tests run the pathological timings a real interview
// produces, with no AudioContext anywhere.

const RATE = 16_000;
const BLOCK = 1_600; // 100ms per delivered block

/** One block of audio whose every sample identifies which block it came from —
 * so a slice can be checked for WHICH audio it contains, not just its length. */
function block(id: number): Float32Array {
  return new Float32Array(BLOCK).fill(id);
}

/** Blocks delivered on time: block n arrives at t = n * 100. */
function steady(count: number): CaptureBuffer {
  const buf = new CaptureBuffer(RATE);
  for (let i = 1; i <= count; i++) buf.push(block(i), i * 100);
  return buf;
}

function idsIn(audio: Float32Array): number[] {
  return [...new Set(Array.from(audio))];
}

describe("CaptureBuffer: wall clock → samples that actually exist", () => {
  it("maps a block edge to an exact sample offset", () => {
    const buf = steady(3);
    expect(buf.sampleAt(0)).toBe(0);
    expect(buf.sampleAt(100)).toBe(BLOCK);
    expect(buf.sampleAt(200)).toBe(2 * BLOCK);
    expect(buf.sampleAt(300)).toBe(buf.totalSamples);
  });

  it("interpolates inside a block", () => {
    const buf = steady(2);
    expect(buf.sampleAt(150)).toBe(BLOCK + BLOCK / 2);
  });

  it("clamps past the end instead of pointing at audio that was never captured", () => {
    const buf = steady(2);
    expect(buf.sampleAt(10_000)).toBe(buf.totalSamples);
    expect(buf.sampleAt(-5_000)).toBe(0);
  });

  it("a late block describes a longer stretch of clock, not a shifted buffer", () => {
    // The tab stalled for 300ms: block 3 carries the same 100ms of audio but
    // is delivered at t=500. Wall-clock arithmetic would put t=450 at sample
    // 7200 — past the 4800 samples that exist. The timeline puts it inside the
    // block that really covers it.
    const buf = new CaptureBuffer(RATE);
    buf.push(block(1), 100);
    buf.push(block(2), 200);
    buf.push(block(3), 500);
    expect(buf.totalSamples).toBe(3 * BLOCK);
    expect(buf.sampleAt(450)).toBeLessThanOrEqual(buf.totalSamples);
    expect(idsIn(buf.slice(buf.sampleAt(400), buf.sampleAt(500)))).toEqual([3]);
  });

  it("a time inside a dropped-audio gap resolves to the next real sample", () => {
    // Blocks for 200–400ms never arrived. Nothing can be extracted from a gap,
    // so the honest answer is where audio resumes — never an index into
    // somebody else's syllables.
    const buf = new CaptureBuffer(RATE);
    buf.push(block(1), 100);
    buf.push(block(2), 200);
    buf.push(block(5), 500); // 300ms of audio simply lost
    expect(buf.sampleAt(350)).toBe(2 * BLOCK); // start of the block that resumed
    expect(idsIn(buf.slice(buf.sampleAt(350), buf.sampleAt(500)))).toEqual([5]);
  });

  it("extracts exactly the blocks a segment covers, late deliveries included", () => {
    const buf = new CaptureBuffer(RATE);
    buf.push(block(1), 100);
    buf.push(block(2), 200);
    buf.push(block(3), 640); // stall
    buf.push(block(4), 740);
    buf.push(block(5), 840);
    // A VAD segment running from the start of block 2 (t=100 is block 1's edge)
    // to the end of block 4 — across the stall.
    const audio = buf.slice(buf.sampleAt(100), buf.sampleAt(740));
    expect(idsIn(audio)).toEqual([2, 3, 4]);
    expect(audio.length).toBe(3 * BLOCK);
  });

  it("an empty buffer answers with an empty slice, never a bogus index", () => {
    const buf = new CaptureBuffer(RATE);
    expect(buf.sampleAt(1234)).toBe(0);
    expect(buf.slice(0, 1000)).toHaveLength(0);
  });
});

describe("CaptureBuffer: trimming keeps a long answer bounded", () => {
  it("releases whole blocks older than the cut and clamps slices to what is left", () => {
    const buf = steady(5);
    buf.trimBefore(2 * BLOCK); // done with blocks 1 and 2
    expect(buf.firstSample).toBe(2 * BLOCK);
    // The caller may still ask for the old range; it gets what survives.
    expect(idsIn(buf.slice(0, buf.totalSamples))).toEqual([3, 4, 5]);
  });

  it("never releases a block the cut only partly covers", () => {
    const buf = steady(3);
    buf.trimBefore(BLOCK + 10); // mid-block 2
    expect(buf.firstSample).toBe(BLOCK);
    expect(idsIn(buf.slice(BLOCK, buf.totalSamples))).toEqual([2, 3]);
  });

  it("a trimmed timeline still maps times correctly for the audio it kept", () => {
    const buf = steady(4);
    buf.trimBefore(2 * BLOCK);
    expect(buf.sampleAt(300)).toBe(3 * BLOCK);
    expect(idsIn(buf.slice(buf.sampleAt(200), buf.sampleAt(300)))).toEqual([3]);
  });
});

describe("segment hygiene", () => {
  it("downsamples to the speech-model rate", () => {
    const out = downsample(new Float32Array(48_000).fill(0.5), 48_000);
    expect(out.length).toBe(STT_TARGET_RATE);
    expect(out[0]).toBe(0.5);
  });

  it("recognises Whisper's silence hallucinations", () => {
    expect(looksLikeHallucination("Thank you.")).toBe(true);
    expect(looksLikeHallucination("[BLANK_AUDIO]")).toBe(true);
    expect(looksLikeHallucination("")).toBe(true);
    expect(looksLikeHallucination("Thanks for the question, my project was")).toBe(false);
  });
});
