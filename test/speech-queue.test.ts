import { beforeEach, describe, expect, it, vi } from "vitest";

// The multiple-voices regression suite.
//
// The interviewer changing voice mid-answer had one structural cause: a reply
// was synthesized as one request PER SENTENCE, and each request could fail (or
// be sampled) independently. These tests pin the two rules that fixed it:
//
//   1. TWO DRAWS MAX — a turn costs at most two synthesis requests, however
//      many sentences it contains.
//   2. The first sentence still starts immediately, so rule 1 did not buy
//      consistency by making the interviewer slow.

const speakCalls: string[] = [];
const prepareCalls: string[] = [];

/** A SpeakHandle that finishes on the next microtask. */
function fakeHandle(onCancel?: () => void) {
  return {
    done: Promise.resolve(),
    cancel: () => onCancel?.(),
    firstSyllableAt: Promise.resolve(Date.now()),
    engineUsed: Promise.resolve("cloud" as const),
  };
}

vi.mock("@/lib/tts", () => ({
  getVoiceEngine: () => "cloud",
  isServerVoiceEngine: () => true,
  speak: (text: string) => {
    speakCalls.push(text);
    return fakeHandle();
  },
  prepareSpeak: (text: string) => {
    prepareCalls.push(text);
    return {
      ready: Promise.resolve(),
      play: () => {
        speakCalls.push(text);
        return fakeHandle();
      },
      cancel: () => {},
    };
  },
}));

import { createSpeechQueue } from "@/lib/speech-queue";

beforeEach(() => {
  speakCalls.length = 0;
  prepareCalls.length = 0;
});

describe("speech queue — the two-draw rule", () => {
  it("a five-sentence reply costs TWO synthesis draws, not five", async () => {
    const q = createSpeechQueue({ voice: "hr" });
    for (const s of [
      "That is a good place to start.",
      "Tell me about the hardest bug you hit.",
      "I am interested in how you narrowed it down.",
      "Take your time with it.",
      "Whenever you are ready.",
    ]) {
      q.push(s);
    }
    q.end();
    await q.done;

    expect(q.size).toBe(5);
    expect(q.draws).toBe(2);
    // Draw 1 is the opening sentence alone; draw 2 is everything else, joined.
    expect(speakCalls).toHaveLength(2);
    expect(speakCalls[0]).toBe("That is a good place to start.");
    expect(speakCalls[1]).toBe(
      "Tell me about the hardest bug you hit. I am interested in how you narrowed it down. Take your time with it. Whenever you are ready.",
    );
  });

  it("a one-sentence reply is a single draw", async () => {
    const q = createSpeechQueue({ voice: "hr" });
    q.push("Why do you want this role?");
    q.end();
    await q.done;

    expect(q.draws).toBe(1);
    expect(speakCalls).toEqual(["Why do you want this role?"]);
  });

  it("the opening sentence is spoken live, before the turn has closed", async () => {
    const q = createSpeechQueue({ voice: "hr" });
    q.push("Let me ask you something else.");
    // No end() yet — the model is still writing. The first sentence must not
    // wait for the turn to close, or every reply gains the model's full
    // generation time before a single syllable.
    await vi.waitFor(() => expect(speakCalls).toHaveLength(1));
    expect(speakCalls[0]).toBe("Let me ask you something else.");

    q.push("How did you approach it?");
    q.end();
    await q.done;
    expect(q.draws).toBe(2);
  });

  it("draw 2 is PREPARED while draw 1 plays, so the hand-off is not a synthesis gap", async () => {
    const q = createSpeechQueue({ voice: "hr" });
    q.push("First sentence of the reply.");
    q.push("Second sentence of the reply.");
    q.end();
    await q.done;

    expect(prepareCalls).toEqual(["Second sentence of the reply."]);
  });

  it("cancel() before anything is pushed never speaks", async () => {
    const q = createSpeechQueue({ voice: "hr" });
    q.cancel();
    q.push("Should never be spoken.");
    q.end();
    await q.done;

    expect(speakCalls).toHaveLength(0);
    expect(q.draws).toBe(0);
  });

  it("push() after end() is ignored", async () => {
    const q = createSpeechQueue({ voice: "hr" });
    q.push("The only sentence.");
    q.end();
    q.push("Arrived too late.");
    await q.done;

    expect(speakCalls).toEqual(["The only sentence."]);
  });

  it("an empty turn resolves instead of hanging the interview", async () => {
    const q = createSpeechQueue({ voice: "hr" });
    q.end();
    await q.done;

    expect(speakCalls).toHaveLength(0);
    await expect(q.firstSyllableAt).resolves.toBeTypeOf("number");
    await expect(q.engineUsed).resolves.toBe("cloud");
  });

  it("whitespace-only pushes never become their own draw", async () => {
    const q = createSpeechQueue({ voice: "hr" });
    q.push("A real sentence here.");
    q.push("   ");
    q.push("\n\t");
    q.end();
    await q.done;

    expect(q.draws).toBe(1);
    expect(speakCalls).toEqual(["A real sentence here."]);
  });
});
