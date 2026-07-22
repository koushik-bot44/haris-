import { describe, expect, it } from "vitest";
import { stripSpeechTags, TURBO_TAGS } from "@/lib/speakable";

describe("speakable tag stripping (captions/transcripts never show raw tags)", () => {
  it("exposes exactly the four Chatterbox-Turbo tags", () => {
    expect(TURBO_TAGS).toEqual(["[chuckle]", "[sigh]", "[clear throat]", "[gasp]"]);
  });

  it("strips a tag at the start without leaving leading whitespace", () => {
    expect(stripSpeechTags("[chuckle] That's a fair point.")).toBe("That's a fair point.");
  });

  it("strips a tag in the middle and collapses the doubled space", () => {
    expect(stripSpeechTags("Okay [sigh] let's switch gears.")).toBe("Okay let's switch gears.");
  });

  it("strips a tag at the end without leaving trailing whitespace", () => {
    expect(stripSpeechTags("Walk me through that again. [clear throat]")).toBe("Walk me through that again.");
  });

  it("is case-insensitive for known tags", () => {
    expect(stripSpeechTags("[Gasp] Really? [CHUCKLE]")).toBe("Really?");
  });

  it("preserves unknown bracketed text", () => {
    expect(stripSpeechTags("[laughs] I used O(n) time [citation needed].")).toBe(
      "[laughs] I used O(n) time [citation needed].",
    );
  });

  it("is idempotent", () => {
    const once = stripSpeechTags("Right. [sigh] So what breaks first?");
    expect(stripSpeechTags(once)).toBe(once);
  });

  it("leaves tag-free text untouched", () => {
    const text = "Tell me about a bug that took you a long time to find.";
    expect(stripSpeechTags(text)).toBe(text);
  });
});
