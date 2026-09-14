import { describe, expect, it } from "vitest";
import {
  CHATTERBOX_DEFAULT_TUNING,
  chatterboxRequestBody,
  chatterboxSeed,
  chatterboxVoiceFile,
  chatterboxVoicesOf,
} from "@/lib/chatterbox-request";

// The request the browser sends straight to the candidate's own Chatterbox
// server must be the request the /api/tts route sends — one speaker, one
// rendering, whichever path carried the line.

describe("chatterbox request shape", () => {
  it("is deterministic per persona and never zero (zero re-rolls the voice)", () => {
    expect(chatterboxSeed("hr")).toBe(chatterboxSeed("hr"));
    expect(chatterboxSeed("hr")).not.toBe(chatterboxSeed("technical"));
    expect(chatterboxSeed("hr")).toBeGreaterThan(0);
    expect(chatterboxSeed("hr", 0)).toBe(0); // the documented "random" override
  });

  it("resolves persona keys through the cast and lets CHATTERBOX_VOICE override the interviewers only", () => {
    expect(chatterboxVoiceFile("hr")).toBe("Emily.wav");
    expect(chatterboxVoiceFile("technical")).toBe("Michael.wav");
    expect(chatterboxVoiceFile("technical", "Cloned.wav")).toBe("Cloned.wav");
    expect(chatterboxVoiceFile("moderator", "Cloned.wav")).toBe("Olivia.wav");
    expect(chatterboxVoiceFile("Custom.wav", "Cloned.wav")).toBe("Custom.wav"); // a legacy filename is used as is
    expect(chatterboxVoiceFile(undefined)).toBe("Emily.wav");
  });

  it("streams through the native endpoint and buffers through the SAME one, with identical knobs", () => {
    const tuning = { seed: chatterboxSeed("hr"), ...CHATTERBOX_DEFAULT_TUNING };
    const streamed = chatterboxRequestBody("Hello.", "Emily.wav", true, tuning);
    const buffered = chatterboxRequestBody("Hello.", "Emily.wav", false, tuning);
    expect(streamed).toMatchObject({ voice_mode: "predefined", predefined_voice_id: "Emily.wav", stream: true, split_text: true, chunk_size: 50, temperature: 0.7 });
    expect(buffered).toMatchObject({ output_format: "wav", stream: false, chunk_size: 50, seed: tuning.seed, temperature: 0.7, exaggeration: 0.5, cfg_weight: 0.5, speed_factor: 1 });
    expect(chatterboxRequestBody("x", "Emily.wav", true, tuning, 10).chunk_size).toBe(50); // clamped to the server's minimum
    expect(chatterboxRequestBody("x", "Emily.wav", true, tuning, 5000).chunk_size).toBe(500);
  });

  it("recognises the voices endpoint and nothing else", () => {
    expect(chatterboxVoicesOf({ voices: ["Emily.wav", 3, "Michael.wav"] })).toEqual(["Emily.wav", "Michael.wav"]);
    expect(chatterboxVoicesOf({ hello: "world" })).toBeNull();
    expect(chatterboxVoicesOf(null)).toBeNull();
    expect(chatterboxVoicesOf("nope")).toBeNull();
  });
});
