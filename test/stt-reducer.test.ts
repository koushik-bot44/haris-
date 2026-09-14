import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dedupeKey,
  fullTranscript,
  initialSttState,
  MAX_ENGINE_ERRORS,
  MAX_RESTARTS,
  sttReduce,
  type SttAction,
  type SttState,
} from "@/lib/stt-reducer";
import { getSttEngine, setSttEngineEphemeral } from "@/lib/stt";

// The most fragile code in the project, tested without a mic: scripted
// onresult/onend/onerror interleavings drive the pure reducer.

function run(actions: SttAction[]) {
  let state: SttState = initialSttState();
  const effects: string[] = [];
  for (const a of actions) {
    const out = sttReduce(state, a);
    state = out.state;
    if (out.effect) effects.push(out.effect.kind + (out.effect.kind === "degrade_to_text" ? `:${out.effect.reason}` : ""));
  }
  return { state, effects };
}

describe("stt reducer", () => {
  it("accumulates transcript across engine auto-restarts", () => {
    const { state, effects } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "my name is", isFinal: false },
      { type: "RESULT", t: 900, text: "my name is hari", isFinal: true },
      { type: "ENGINE_END", t: 1000 }, // Chrome auto-stop mid-answer
      { type: "RESULT", t: 1400, text: "and I study CS", isFinal: true },
      { type: "STOP", t: 2000 },
    ]);
    expect(effects).toContain("restart");
    expect(fullTranscript(state)).toBe("my name is hari and I study CS");
    expect(state.phase).toBe("stopped");
  });

  it("promotes unfinalized interim text when the engine ends", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "I was about to say", isFinal: false },
      { type: "ENGINE_END", t: 500 },
      { type: "STOP", t: 900 },
    ]);
    expect(fullTranscript(state)).toBe("I was about to say");
  });

  it("degrades immediately on mic permission denial", () => {
    const { state, effects } = run([
      { type: "START", t: 0 },
      { type: "ERROR", t: 50, error: "not-allowed" },
    ]);
    expect(state.phase).toBe("failed");
    expect(effects).toContain("degrade_to_text:not-allowed");
  });

  it("survives one network error but degrades on the second consecutive one", () => {
    const first = run([
      { type: "START", t: 0 },
      { type: "ERROR", t: 100, error: "network" },
    ]);
    expect(first.state.phase).toBe("listening");

    const second = run([
      { type: "START", t: 0 },
      { type: "ERROR", t: 100, error: "network" },
      { type: "ERROR", t: 300, error: "network" },
    ]);
    expect(second.state.phase).toBe("failed");
    expect(second.effects).toContain("degrade_to_text:network");
  });

  it("a no-speech blip does NOT count toward the network degrade budget", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "ERROR", t: 100, error: "no-speech" },
      { type: "ERROR", t: 300, error: "network" }, // first NETWORK error — survivable
    ]);
    expect(state.phase).toBe("listening");
  });

  it("a restart refreshes the silence anchor so the reconnect gap is not counted as silence", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 1000, text: "still talking", isFinal: true },
      { type: "ENGINE_END", t: 2800 }, // engine died mid-speech, 1.8s after last result
    ]);
    expect(state.lastSpeechT).toBe(2800); // anchor moved to the restart moment
  });

  it("accepts Chrome's post-stop final result, replacing the promoted interim", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 500, text: "my final answer is", isFinal: false },
      { type: "STOP", t: 900 }, // promotes interim
      { type: "RESULT", t: 1100, text: "my final answer is teamwork", isFinal: true },
    ]);
    expect(fullTranscript(state)).toBe("my final answer is teamwork");
  });

  it("a real result resets the consecutive error budget", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "ERROR", t: 100, error: "network" },
      { type: "RESULT", t: 300, text: "still here", isFinal: true },
      { type: "ERROR", t: 500, error: "network" },
    ]);
    expect(state.phase).toBe("listening"); // budget reset by speech — one error again survivable
  });

  it("caps restarts to avoid an infinite restart loop", () => {
    const actions: SttAction[] = [{ type: "START", t: 0 }];
    for (let i = 0; i <= MAX_RESTARTS; i++) actions.push({ type: "ENGINE_END", t: 100 + i });
    const { state, effects } = run(actions);
    expect(state.phase).toBe("failed");
    expect(effects.filter((e) => e === "restart").length).toBe(MAX_RESTARTS);
    expect(effects).toContain("degrade_to_text:too_many_restarts");
  });

  it("records a trace usable as a fixture (start, results, restart markers)", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "hello", isFinal: true },
      { type: "ENGINE_END", t: 200 },
      { type: "RESULT", t: 900, text: "world", isFinal: true },
      { type: "STOP", t: 1000 },
    ]);
    const kinds = state.trace.map((e) => e.kind);
    expect(kinds).toEqual(["start", "result", "restart", "result", "stop"]);
  });
});

describe("revision merging (the duplicated last sentence)", () => {
  it("a post-stop final that only re-punctuates the interim does not duplicate it", () => {
    // Chrome's real behaviour: the interim promoted at STOP comes back
    // capitalised and with a full stop. A raw prefix test sees two different
    // strings and appends — which duplicated the last sentence of nearly every
    // spoken answer.
    const { state } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 500, text: "my final answer is teamwork", isFinal: false },
      { type: "STOP", t: 900 },
      { type: "RESULT", t: 1100, text: "My final answer is teamwork.", isFinal: true },
    ]);
    expect(state.finalSegments).toHaveLength(1);
    expect(fullTranscript(state)).toBe("My final answer is teamwork."); // the better-punctuated wording wins
  });

  it("a post-stop final that EXTENDS the interim replaces it, punctuation and all", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 500, text: "my final answer is", isFinal: false },
      { type: "STOP", t: 900 },
      { type: "RESULT", t: 1100, text: "My final answer is teamwork.", isFinal: true },
    ]);
    expect(fullTranscript(state)).toBe("My final answer is teamwork.");
  });

  it("an unrelated post-stop final is still appended", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 500, text: "I optimized the query.", isFinal: true },
      { type: "STOP", t: 900 },
      { type: "RESULT", t: 1100, text: "It dropped to 40 milliseconds.", isFinal: true },
    ]);
    expect(state.finalSegments).toHaveLength(2);
  });

  it("an engine restart re-delivering the promoted interim does not duplicate it", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "I was about to say", isFinal: false },
      { type: "ENGINE_END", t: 500 }, // promotes the interim
      { type: "RESULT", t: 700, text: "I was about to say.", isFinal: true }, // the dying engine's late final
      { type: "STOP", t: 900 },
    ]);
    expect(fullTranscript(state)).toBe("I was about to say.");
  });

  it("dedupeKey ignores case, punctuation and spacing but nothing else", () => {
    expect(dedupeKey("My final answer is teamwork.")).toBe(dedupeKey("my  final answer, is teamwork"));
    expect(dedupeKey("we used Redis")).not.toBe(dedupeKey("we used Postgres"));
  });
});

describe("silence anchor and engine failures on the batch-transcriber path", () => {
  it("a late segment result never drags the silence anchor backwards", () => {
    // The cloud/Whisper path reports the wall clock a segment ENDED, which is
    // already in the past when the text comes back. If the candidate resumed
    // talking meanwhile, moving the anchor back would end the answer
    // mid-sentence a moment later.
    const { state } = run([
      { type: "START", t: 0 },
      { type: "SPEECH_ACTIVITY", t: 6000 }, // still talking
      { type: "RESULT", t: 5000, text: "the segment that just came back", isFinal: true },
    ]);
    expect(state.lastSpeechT).toBe(6000);
  });

  it("transcription failures hand over after three in a row", () => {
    const two = run([
      { type: "START", t: 0 },
      { type: "ERROR", t: 100, error: "cloud_transcribe" },
      { type: "ERROR", t: 200, error: "cloud_transcribe" },
    ]);
    expect(two.state.phase).toBe("listening"); // one Groq hiccup costs nobody their voice

    const actions: SttAction[] = [{ type: "START", t: 0 }];
    for (let i = 0; i < MAX_ENGINE_ERRORS; i++) actions.push({ type: "ERROR", t: 100 + i, error: "cloud_transcribe" });
    const three = run(actions);
    expect(three.state.phase).toBe("failed");
    expect(three.effects).toContain("degrade_to_text:cloud_transcribe");
  });

  it("a successful transcription resets the failure budget", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "ERROR", t: 100, error: "cloud_transcribe" },
      { type: "ERROR", t: 200, error: "cloud_transcribe" },
      { type: "RESULT", t: 300, text: "back in business", isFinal: true },
      { type: "ERROR", t: 400, error: "cloud_transcribe" },
      { type: "ERROR", t: 500, error: "cloud_transcribe" },
    ]);
    expect(state.phase).toBe("listening");
  });

  it("Chrome's routine no-speech spam never counts as an engine failure", () => {
    const actions: SttAction[] = [{ type: "START", t: 0 }];
    for (let i = 0; i < 8; i++) actions.push({ type: "ERROR", t: 100 + i, error: "no-speech" });
    const { state } = run(actions);
    expect(state.phase).toBe("listening");
  });
});

describe("ephemeral STT engine override (a transient degrade must not persist)", () => {
  afterEach(() => {
    setSttEngineEphemeral(null);
    vi.unstubAllGlobals();
  });

  it("overrides getSttEngine for the session and clears with null", () => {
    expect(getSttEngine()).toBe("auto"); // node: no window, no stored preference
    setSttEngineEphemeral("whisper");
    expect(getSttEngine()).toBe("whisper");
    setSttEngineEphemeral(null);
    expect(getSttEngine()).toBe("auto");
  });

  it("never writes localStorage — the stored preference survives the session", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    setSttEngineEphemeral("whisper");
    expect(getSttEngine()).toBe("whisper");
    expect(store.size).toBe(0); // the degrade-time switch left no trace
    setSttEngineEphemeral(null);
    expect(getSttEngine()).toBe("auto"); // back to the (unset) stored preference
  });
});

describe("what an answer records when the recogniser fails", () => {
  it("counts in-flight segments and their outcomes", async () => {
    const { answerTextFor, captureOutcome, initialSttState, sttReduce } = await import("@/lib/stt-reducer");
    let s = initialSttState();
    s = sttReduce(s, { type: "START", t: 0 }).state;
    s = sttReduce(s, { type: "SPEECH_ACTIVITY", t: 100 }).state;
    s = sttReduce(s, { type: "SEGMENT_SENT", t: 200 }).state;
    expect(s.pending).toBe(1);
    s = sttReduce(s, { type: "SEGMENT_SETTLED", t: 900, outcome: "lost" }).state;
    expect(s.pending).toBe(0);
    expect(s.lostSegments).toBe(1);
    // Spoke, nothing came back → unheard, never "(no answer)".
    expect(answerTextFor("", captureOutcome(s))).toBe("(unheard)");
    // A later segment worked → the answer is partial, marked as such.
    s = sttReduce(s, { type: "RESULT", t: 1500, text: "and then I fixed the bug", isFinal: true }).state;
    expect(answerTextFor("and then I fixed the bug", captureOutcome(s))).toBe("and then I fixed the bug (part of the answer was not captured)");
  });

  it("true silence is still silence, and a clean capture is untouched", async () => {
    const { answerTextFor, initialSttState, captureOutcome } = await import("@/lib/stt-reducer");
    expect(answerTextFor("", captureOutcome(initialSttState()))).toBe("(no answer)");
    expect(answerTextFor("", undefined)).toBe("(no answer)");
    expect(answerTextFor("  I built it myself.  ", { heard: true, lost: 0, empty: 0 })).toBe("I built it myself.");
  });
});

describe("segment order follows the speech, not the transcriber", () => {
  // Browser run (timeout scenario): the first segment's request hung, timed
  // out at 12 s and was retried; its text came back AFTER the second segment
  // and was appended — the interviewer read "…only one order can exist per
  // listing. The hardest part was…". A batch result carries the time its
  // speech ended, and that is where it belongs.
  it("puts a late (retried) segment back where it was spoken", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "SEGMENT_SENT", t: 3000 },
      { type: "SEGMENT_SENT", t: 6000 },
      { type: "RESULT", t: 6000, text: "Only one order can exist per listing.", isFinal: true },
      { type: "SEGMENT_SETTLED", t: 7000, outcome: "ok" },
      { type: "RESULT", t: 3000, text: "I fixed it by adding a unique check so", isFinal: true },
      { type: "SEGMENT_SETTLED", t: 15_000, outcome: "ok" },
      { type: "STOP", t: 16_000 },
    ]);
    expect(fullTranscript(state)).toBe("I fixed it by adding a unique check so Only one order can exist per listing.");
    expect(state.pending).toBe(0);
  });

  it("also after the answer closed (a late final in the stopped phase)", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "SEGMENT_SENT", t: 3000 },
      { type: "SEGMENT_SENT", t: 6000 },
      { type: "RESULT", t: 6000, text: "and after that it never happened again.", isFinal: true },
      { type: "STOP", t: 9000 },
      { type: "RESULT", t: 3000, text: "The hardest part was a race on checkout,", isFinal: true },
    ]);
    expect(fullTranscript(state)).toBe("The hardest part was a race on checkout, and after that it never happened again.");
  });

  it("a revision of an earlier segment still merges into it, wherever it lands", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 3000, text: "we used redis", isFinal: true },
      { type: "RESULT", t: 6000, text: "for the session cache.", isFinal: true },
      { type: "RESULT", t: 3000, text: "We used Redis.", isFinal: true },
    ]);
    expect(state.finalSegments).toEqual(["We used Redis.", "for the session cache."]);
  });

  it("Chrome's in-order results are unaffected", () => {
    const { state } = run([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "my name is", isFinal: false },
      { type: "RESULT", t: 900, text: "my name is hari", isFinal: true },
      { type: "RESULT", t: 1400, text: "and I study CS", isFinal: true },
      { type: "STOP", t: 2000 },
    ]);
    expect(fullTranscript(state)).toBe("my name is hari and I study CS");
    expect(state.finalEnds).toEqual([900, 1400]);
  });
});
