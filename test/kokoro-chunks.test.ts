import { describe, expect, it, vi } from "vitest";

// Kokoro renders a whole chunk before any of it plays, so the first chunk's
// length is the time to first audio. A real-browser run measured 5–7 s from
// "answer recorded" to the first syllable when the opening chunk was a full
// ~8 s sentence. kokoroChunks() opens with a short clause and lets the
// pipelined generate-next-while-playing hide the rest — same voice throughout.

vi.mock("@/lib/audio-viz", () => ({
  setAiHue: vi.fn(),
  startPseudoTalking: vi.fn(),
  stopPseudoTalking: vi.fn(),
  tapPlayback: vi.fn(),
}));
vi.mock("@/lib/tts-kokoro", () => ({
  ensureKokoroLoading: vi.fn(),
  kokoroReady: vi.fn(async () => true),
  kokoroSpeak: vi.fn(),
  kokoroStatus: vi.fn(() => "ready"),
  kokoroProgress: vi.fn(() => null),
  PRIYA_VOICE: "af_heart",
}));

import { kokoroChunks } from "@/lib/tts";

describe("kokoroChunks — a short opening chunk for fast first audio", () => {
  it("cuts a long first sentence at its last clause boundary inside the cap", () => {
    const text =
      "That sounds like a solid project, especially handling real-time voice, and I would like to hear how the pieces fit together. What was the hardest part?";
    const chunks = kokoroChunks(text);
    expect(chunks[0]).toBe("That sounds like a solid project,");
    expect(chunks[0].length).toBeLessThanOrEqual(72);
    expect(chunks[1]).toBe(
      "especially handling real-time voice, and I would like to hear how the pieces fit together.",
    );
    expect(chunks[2]).toBe("What was the hardest part?");
    // Nothing is lost or duplicated.
    expect(chunks.join(" ")).toBe(text);
  });

  it("leaves a short first sentence alone", () => {
    expect(kokoroChunks("Tell me about yourself. Take your time.")).toEqual(["Tell me about yourself.", "Take your time."]);
  });

  it("falls back to a word boundary when there is no clause boundary", () => {
    const text = "Walk me through the main components of the system you built for your final year project and how they talk to each other.";
    const chunks = kokoroChunks(text);
    expect(chunks[0].length).toBeLessThanOrEqual(72);
    expect(chunks[0].length).toBeGreaterThanOrEqual(28);
    expect(chunks[0].endsWith(" ")).toBe(false);
    expect(chunks.join(" ")).toBe(text);
  });

  it("never opens with a fragment shorter than the floor", () => {
    // A comma very early must not produce a two-word opening chunk.
    const text = "Right, so before we go any further into the technical side of things I want to understand your motivation.";
    const chunks = kokoroChunks(text);
    expect(chunks[0].length).toBeGreaterThanOrEqual(28);
  });

  it("empty text yields no chunks", () => {
    expect(kokoroChunks("")).toEqual([]);
  });
});
