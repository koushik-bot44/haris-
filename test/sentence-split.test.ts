import { describe, expect, it } from "vitest";
import { completeSentences, SentenceStreamer, splitForSpeech } from "@/lib/sentence-split";

describe("completeSentences (voice pipelining boundaries)", () => {
  it("returns closed sentences and the streaming remainder", () => {
    const r = completeSentences("Nice to meet you, Hari. Tell me about your project. And then");
    expect(r.sentences).toEqual(["Nice to meet you, Hari.", "Tell me about your project."]);
    expect(r.rest).toBe("And then");
  });

  it("never closes on a terminator at the very end of a growing buffer", () => {
    expect(completeSentences("The score was 8.").sentences).toEqual([]);
    expect(completeSentences("The score was 8.", true).sentences).toEqual(["The score was 8."]);
  });

  it("does not split inside tokens like 8.5 or e.g.x", () => {
    expect(completeSentences("We hit 8.5 percent growth last year. Then more").sentences).toEqual([
      "We hit 8.5 percent growth last year.",
    ]);
  });

  it("merges tiny fragments into the next sentence", () => {
    expect(completeSentences("Hi. Nice to meet you properly. And").sentences).toEqual(["Hi. Nice to meet you properly."]);
  });

  it("treats abbreviations as non-boundaries", () => {
    expect(completeSentences("I studied under Dr. Rao at the institute. Next").sentences).toEqual([
      "I studied under Dr. Rao at the institute.",
    ]);
  });

  it("keeps closing quotes and brackets with their sentence", () => {
    expect(completeSentences('She said "we shipped it early." Then we').sentences).toEqual(['She said "we shipped it early."']);
  });

  it("splitForSpeech includes the trailing fragment", () => {
    expect(splitForSpeech("First sentence here. Second one here! Trailing bit")).toEqual([
      "First sentence here.",
      "Second one here!",
      "Trailing bit",
    ]);
  });
});

describe("SentenceStreamer", () => {
  it("hands out each sentence exactly once across feeds", () => {
    const s = new SentenceStreamer();
    expect(s.feed("Nice to meet").sentences).toEqual([]);
    expect(s.feed("Nice to meet you, Hari. Tell me").sentences).toEqual(["Nice to meet you, Hari."]);
    expect(s.feed("Nice to meet you, Hari. Tell me about").sentences).toEqual([]);
    expect(s.feed("Nice to meet you, Hari. Tell me about your project. So").sentences).toEqual(["Tell me about your project."]);
    expect(s.spoken).toBe("Nice to meet you, Hari. Tell me about your project.");
  });

  it("flush() returns only the unspoken tail of the final text", () => {
    const s = new SentenceStreamer();
    s.feed("One thing first. Then the");
    const f = s.flush("One thing first. Then the real question.");
    expect(f).toEqual({ rest: "Then the real question.", mismatch: false });
  });

  it("flush() flags a final text that no longer contains what was spoken", () => {
    const s = new SentenceStreamer();
    s.feed("Let me ask about Java. And");
    const f = s.flush("Tell me about your strengths.");
    expect(f.mismatch).toBe(true);
  });

  it("feed() reports a reset when the stream stops being a prefix extension", () => {
    const s = new SentenceStreamer();
    s.feed("Let me ask about Java. And");
    const r = s.feed("Completely different reply. Yes");
    expect(r.reset).toBe(true);
    expect(r.sentences).toEqual(["Completely different reply."]);
  });
});
