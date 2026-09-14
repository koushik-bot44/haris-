import { beforeEach, describe, expect, it } from "vitest";
import { CACHEABLE_TEXT_MAX, ttsCacheClear, ttsCacheGet, ttsCacheKey, ttsCacheSet, ttsCacheStats } from "@/lib/tts-cache";

beforeEach(() => ttsCacheClear());

describe("tts cache (short repeated lines never re-synthesize)", () => {
  it("normalises whitespace in the key and round-trips bytes", () => {
    const k1 = ttsCacheKey("groq", "hr", "Mm,   okay.");
    const k2 = ttsCacheKey("groq", "hr", " Mm, okay. ");
    expect(k1).toBe(k2);
    ttsCacheSet(k1, new Uint8Array([1, 2, 3]));
    expect(Array.from(ttsCacheGet(k2)!)).toEqual([1, 2, 3]);
    expect(ttsCacheGet(ttsCacheKey("groq", "technical", "Mm, okay."))).toBeNull(); // voice is part of the key
  });

  it("evicts the least recently used entry past the entry cap", () => {
    for (let i = 0; i < 96; i++) ttsCacheSet(ttsCacheKey("groq", "hr", `line ${i}`), new Uint8Array([i]));
    ttsCacheGet(ttsCacheKey("groq", "hr", "line 0")); // touch → most recent
    ttsCacheSet(ttsCacheKey("groq", "hr", "line 96"), new Uint8Array([96]));
    expect(ttsCacheStats().entries).toBe(96);
    expect(ttsCacheGet(ttsCacheKey("groq", "hr", "line 0"))).not.toBeNull();
    expect(ttsCacheGet(ttsCacheKey("groq", "hr", "line 1"))).toBeNull();
  });

  it("only short lines are meant to be cached", () => {
    expect(CACHEABLE_TEXT_MAX).toBe(160);
  });
});
