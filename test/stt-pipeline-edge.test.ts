import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/ack pulls in the browser-only TTS module (kokoro loader, AudioContext)
// purely for its engine check. The ack LINES are what this file needs — the
// echo reference the room hands the barge-in filter is the question text PLUS
// every line the app itself speaks, and those lines must be the real ones.
vi.mock("@/lib/tts", () => ({
  getVoiceEngine: () => "cloud",
  isServerVoiceEngine: () => true,
}));

import { ACK_TEXTS } from "@/lib/ack";
import {
  BARGE_IN_WARMUP_MS,
  decideBargeIn,
  dropSelfEcho,
  echoOverlap,
  ECHO_OVERLAP_THRESHOLD,
  ECHO_RUN_TOKENS,
  longestSharedRun,
  MIN_INTERRUPT_CHARS,
  MIN_INTERRUPT_NOVEL_WORDS,
  MIN_INTERRUPT_WORDS,
  novelWordCount,
} from "@/lib/barge-in";
import { micHelp } from "@/lib/mic-help";
import { startChromeStt } from "@/lib/stt";
import {
  dedupeKey,
  fullTranscript,
  initialSttState,
  MAX_RESTARTS,
  sttReduce,
  type SttAction,
  type SttState,
} from "@/lib/stt-reducer";
import { deepgramLiveEnabled, sttProvider } from "@/lib/stt-server";
import { DEFAULT_VAD, initialVadState, vadStep, type VadConfig, type VadEvent, type VadState } from "@/lib/vad";

// ———————————————————————————————————————————————————————————————
// Shared drivers
// ———————————————————————————————————————————————————————————————

type Effects = string[];

function drive(actions: SttAction[], from: SttState = initialSttState()): { state: SttState; effects: Effects } {
  let state = from;
  const effects: Effects = [];
  for (const a of actions) {
    const out = sttReduce(state, a);
    state = out.state;
    if (out.effect) {
      effects.push(out.effect.kind === "degrade_to_text" ? `degrade:${out.effect.reason}` : out.effect.kind);
    }
  }
  return { state, effects };
}

type Segment = { kind: "segment"; startT: number; endT: number };
type Activity = { kind: "activity"; t: number };

function feed(samples: Array<[number, number]>, cfg: VadConfig = DEFAULT_VAD): {
  state: VadState;
  events: NonNullable<VadEvent>[];
} {
  let state = initialVadState();
  const events: NonNullable<VadEvent>[] = [];
  for (const [rms, t] of samples) {
    const out = vadStep(state, rms, t, cfg);
    state = out.state;
    if (out.event) events.push(out.event);
  }
  return { state, events };
}

const segmentsOf = (events: NonNullable<VadEvent>[]): Segment[] =>
  events.filter((e): e is Segment => e.kind === "segment");
const activityOf = (events: NonNullable<VadEvent>[]): Activity[] =>
  events.filter((e): e is Activity => e.kind === "activity");

const LOUD = 0.05;
const MID = 0.01; // between exitRms (0.008) and enterRms (0.015)
const QUIET = 0.001;

const PRIYA = "Tell me about a time you worked in a team and things did not go smoothly. What did you do?";

// ———————————————————————————————————————————————————————————————
// Reducer: the phase gate
// ———————————————————————————————————————————————————————————————

// Every engine keeps firing callbacks after the room has moved on: Chrome
// flushes buffered audio after stop(), a batch transcriber resolves a POST
// seconds later, a dying recognizer emits one last onend. Which of those may
// still change the transcript is the whole safety story of this reducer — an
// event accepted in the wrong phase either resurrects a finished answer or
// restarts a mic the candidate has already put down.

describe("stt reducer: events arriving outside the listening phase", () => {
  const beforeStart: Array<{ label: string; action: SttAction }> = [
    { label: "an interim result", action: { type: "RESULT", t: 10, text: "ghost words", isFinal: false } },
    { label: "a final result", action: { type: "RESULT", t: 10, text: "ghost words", isFinal: true } },
    { label: "speech energy", action: { type: "SPEECH_ACTIVITY", t: 10 } },
    { label: "an engine end", action: { type: "ENGINE_END", t: 10 } },
  ];

  it.each(beforeStart)("$label before START changes nothing and restarts nothing", ({ action }) => {
    const { state, effects } = drive([action]);
    expect(state.phase).toBe("idle");
    expect(state.finalSegments).toEqual([]);
    expect(state.interim).toBe("");
    expect(state.lastSpeechT).toBeNull();
    expect(state.restartCount).toBe(0);
    expect(effects).toEqual([]);
  });

  it("an error before START is still recorded in the trace — the degrade UI needs the reason", () => {
    const { state, effects } = drive([{ type: "ERROR", t: 10, error: "not-allowed" }]);
    expect(state.trace).toEqual([{ kind: "error", t: 10, error: "not-allowed" }]);
    expect(state.phase).toBe("idle"); // no phase machine has started yet
    expect(effects).toEqual([]);
  });

  it("STOP with no session ever started still lands in the stopped phase", () => {
    const { state } = drive([{ type: "STOP", t: 10 }]);
    expect(state.phase).toBe("stopped");
    expect(state.trace.map((e) => e.kind)).toEqual(["stop"]);
  });

  it("an interim delivered after STOP is dropped entirely — only finals may extend a closed answer", () => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "the answer", isFinal: true },
      { type: "STOP", t: 200 },
      { type: "RESULT", t: 300, text: "speculative tail", isFinal: false },
    ]);
    expect(state.interim).toBe("");
    expect(fullTranscript(state)).toBe("the answer");
    expect(state.trace.filter((e) => e.kind === "result")).toHaveLength(1);
  });

  it("a post-stop final never moves the silence anchor or clears the error budget", () => {
    // The answer is already over; the silence timer must not be resurrected by
    // audio that was buffered before the candidate stopped talking.
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "ERROR", t: 50, error: "network" },
      { type: "RESULT", t: 100, text: "first part", isFinal: true },
      { type: "STOP", t: 200 },
      { type: "RESULT", t: 900, text: "and the buffered tail", isFinal: true },
    ]);
    expect(fullTranscript(state)).toBe("first part and the buffered tail");
    expect(state.lastSpeechT).toBe(100); // NOT 900
    expect(state.phase).toBe("stopped");
  });

  it("a whitespace-only post-stop final adds no empty segment", () => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "the answer", isFinal: true },
      { type: "STOP", t: 200 },
      { type: "RESULT", t: 300, text: "   \n\t ", isFinal: true },
    ]);
    expect(state.finalSegments).toEqual(["the answer"]);
  });

  it("nothing revives a failed session: no restart, no transcript, no second degrade", () => {
    const { state, effects } = drive([
      { type: "START", t: 0 },
      { type: "ERROR", t: 50, error: "not-allowed" },
      { type: "ENGINE_END", t: 100 },
      { type: "RESULT", t: 150, text: "words after death", isFinal: true },
      { type: "ERROR", t: 200, error: "audio-capture" },
      { type: "SPEECH_ACTIVITY", t: 250 },
    ]);
    expect(effects).toEqual(["degrade:not-allowed"]);
    expect(state.restartCount).toBe(0);
    expect(state.finalSegments).toEqual([]);
    expect(state.phase).toBe("failed");
  });

  it("STOP after a failure closes the session but keeps the reason the UI is explaining", () => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "ERROR", t: 50, error: "audio-capture" },
      { type: "STOP", t: 100 },
    ]);
    expect(state.phase).toBe("stopped");
    expect(state.failReason).toBe("audio-capture");
  });
});

// ———————————————————————————————————————————————————————————————
// Reducer: duplicate finals
// ———————————————————————————————————————————————————————————————

// Every engine re-emits the same words dressed differently — Chrome
// re-punctuates at stop(), a segmenter's padded boundaries re-transcribe the
// words the previous segment ended on. A raw string compare sees two unrelated
// strings and appends, which duplicated the last sentence of nearly every
// spoken answer. These pin exactly which pairs count as "the same utterance".

describe("stt reducer: duplicate finals differing only in dressing", () => {
  const pairs: Array<{ label: string; prev: string; next: string; merged: boolean }> = [
    { label: "case and a full stop", prev: "we used redis", next: "We used Redis.", merged: true },
    { label: "an extension of the same sentence", prev: "we used redis", next: "we used redis for caching", merged: true },
    { label: "the identical string twice", prev: "we used redis", next: "we used redis", merged: true },
    { label: "a smart apostrophe", prev: "I don't know", next: "I don’t know.", merged: true },
    { label: "collapsed whitespace", prev: "the pipeline broke", next: "  the   pipeline\tbroke  ", merged: true },
    { label: "an em dash instead of a comma", prev: "first, we profiled it", next: "First — we profiled it.", merged: true },
    { label: "a prefix that is not a word boundary", prev: "we use react", next: "we use reacts", merged: false },
    { label: "the same words in another order", prev: "hello world", next: "world hello", merged: false },
    { label: "a genuinely new sentence", prev: "I optimized the query", next: "It dropped to 40 milliseconds", merged: false },
    { label: "an insertion in the middle", prev: "we used redis for caching", next: "we used redis heavily for caching", merged: false },
  ];

  it.each(pairs)("$label → merged: $merged", ({ prev, next, merged }) => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: prev, isFinal: true },
      { type: "RESULT", t: 200, text: next, isFinal: true },
    ]);
    expect(state.finalSegments).toHaveLength(merged ? 1 : 2);
  });

  it("on a tie the newer, better-punctuated wording replaces the old one", () => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "we used redis", isFinal: true },
      { type: "RESULT", t: 200, text: "We used Redis.", isFinal: true },
    ]);
    expect(state.finalSegments).toEqual(["We used Redis."]);
  });

  it("a truncated re-delivery never shortens what was already captured", () => {
    // The engine restarted and re-sent a clipped version of the segment it had
    // already delivered in full. Keeping the longer wording is the difference
    // between a scored answer and half a sentence.
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "We used Redis for the session cache.", isFinal: true },
      { type: "RESULT", t: 200, text: "we used redis", isFinal: true },
    ]);
    expect(state.finalSegments).toEqual(["We used Redis for the session cache."]);
  });

  it("a three-step revision collapses into one segment, not three", () => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "so my project", isFinal: true },
      { type: "RESULT", t: 200, text: "So my project was", isFinal: true },
      { type: "RESULT", t: 300, text: "So my project was a placement simulator.", isFinal: true },
    ]);
    expect(state.finalSegments).toEqual(["So my project was a placement simulator."]);
  });

  it("a sentence the candidate genuinely repeats later is NOT collapsed", () => {
    // Merging only ever looks at the PREVIOUS segment, on purpose: "I said no."
    // twice, with something in between, is two real things they said.
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "I said no.", isFinal: true },
      { type: "RESULT", t: 200, text: "They pushed back.", isFinal: true },
      { type: "RESULT", t: 300, text: "I said no.", isFinal: true },
    ]);
    expect(state.finalSegments).toHaveLength(3);
  });

  it("a whitespace-only final clears the interim without recording a segment or moving the anchor", () => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "real words", isFinal: true },
      { type: "ERROR", t: 200, error: "cloud_transcribe" },
      { type: "RESULT", t: 300, text: "   ", isFinal: true },
    ]);
    expect(state.finalSegments).toEqual(["real words"]);
    expect(state.lastSpeechT).toBe(100); // silence, not speech
    expect(state.consecutiveEngineErrors).toBe(1); // an empty result is not evidence the engine works
  });

  const keys: Array<{ label: string; input: string; expected: string }> = [
    { label: "case, padding and punctuation", input: "  Hello,   WORLD!  ", expected: "hello world" },
    { label: "digits survive", input: "It's 100% done.", expected: "it s 100 done" },
    { label: "tabs and newlines are spacing", input: "a\tb\nc", expected: "a b c" },
    { label: "punctuation-only text", input: "!!! ... ---", expected: "" },
    { label: "the empty string", input: "", expected: "" },
    { label: "accents are stripped, not folded", input: "café", expected: "caf" },
    { label: "a non-Latin script has no key at all", input: "नमस्ते", expected: "" },
    { label: "emoji carry no key", input: "🎤🎤", expected: "" },
  ];

  it.each(keys)("dedupeKey: $label", ({ input, expected }) => {
    expect(dedupeKey(input)).toBe(expected);
  });

  it("two fragments that differ only outside the a-z0-9 alphabet share a key", () => {
    expect(dedupeKey("Résumé — 2 years!")).toBe(dedupeKey("r sum 2 years"));
    expect(dedupeKey("we used Redis")).not.toBe(dedupeKey("we use Redis"));
  });
});

// ———————————————————————————————————————————————————————————————
// Reducer: transcript assembly
// ———————————————————————————————————————————————————————————————

// fullTranscript is what reaches scoring, the report and the LLM's next call.
// Anything it mangles is mangled permanently — the audio is long gone.

describe("stt reducer: fullTranscript assembly", () => {
  const cases: Array<{ label: string; segments: string[]; interim: string; expected: string }> = [
    { label: "nothing was said", segments: [], interim: "", expected: "" },
    { label: "whitespace-only interim contributes nothing", segments: ["hello"], interim: "   ", expected: "hello" },
    { label: "the live fragment is appended to the finals", segments: ["hello"], interim: "wor", expected: "hello wor" },
    { label: "segment-internal newlines collapse", segments: ["line one\nline two"], interim: "", expected: "line one line two" },
    { label: "empty segments leave no double space", segments: ["a", "", "b"], interim: "", expected: "a b" },
    { label: "padded segments are joined by exactly one space", segments: ["  a  ", "  b  "], interim: "", expected: "a b" },
    { label: "unicode content is preserved verbatim", segments: ["I ❤️ Go — really"], interim: "", expected: "I ❤️ Go — really" },
    { label: "tabs between words collapse", segments: ["a\t\tb"], interim: "\tc", expected: "a b c" },
  ];

  it.each(cases)("$label", ({ segments, interim, expected }) => {
    const state: SttState = { ...initialSttState(), finalSegments: segments, interim };
    expect(fullTranscript(state)).toBe(expected);
  });
});

// ———————————————————————————————————————————————————————————————
// Reducer: restarts, anchors and error attribution
// ———————————————————————————————————————————————————————————————

// Chrome's recognizer auto-stops on silence and at ~60s, and every engine
// throws errors that mean nothing. Surviving that without either (a) ending an
// answer mid-sentence or (b) leaving a dead mic "live" while every word
// vanishes is the entire job of these counters.

describe("stt reducer: restarts and the silence anchor", () => {
  it("speech between restarts does not refill the restart budget", () => {
    // A recognizer that flaps once per sentence still has to hand over: the
    // restart cap is about the ENGINE being unhealthy, not about silence.
    const actions: SttAction[] = [{ type: "START", t: 0 }];
    for (let i = 0; i <= MAX_RESTARTS; i++) {
      actions.push({ type: "RESULT", t: 100 + i * 10, text: `sentence ${i}`, isFinal: true });
      actions.push({ type: "ENGINE_END", t: 105 + i * 10 });
    }
    const { state, effects } = drive(actions);
    expect(state.phase).toBe("failed");
    expect(effects).toContain("degrade:too_many_restarts");
    expect(state.finalSegments.length).toBeGreaterThan(MAX_RESTARTS);
  });

  it("an engine end before any speech does not fabricate a silence anchor", () => {
    // lastSpeechT stays null so the listen policy still knows nobody has
    // spoken yet, instead of starting a 1.5s countdown from the reconnect.
    const { state, effects } = drive([
      { type: "START", t: 0 },
      { type: "ENGINE_END", t: 3000 },
    ]);
    expect(state.lastSpeechT).toBeNull();
    expect(effects).toEqual(["restart"]);
  });

  it("an engine end promotes the unfinalized hypothesis and restarts in the same step", () => {
    const out = sttReduce(
      drive([
        { type: "START", t: 0 },
        { type: "RESULT", t: 100, text: "half a sentence", isFinal: false },
      ]).state,
      { type: "ENGINE_END", t: 500 },
    );
    expect(out.state.finalSegments).toEqual(["half a sentence"]);
    expect(out.state.interim).toBe("");
    expect(out.effect).toEqual({ kind: "restart" });
  });

  it("an engine end with only whitespace buffered promotes no empty segment", () => {
    const { state, effects } = drive([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "   ", isFinal: false },
      { type: "ENGINE_END", t: 500 },
    ]);
    expect(state.finalSegments).toEqual([]);
    expect(effects).toEqual(["restart"]);
  });

  const anchors: Array<{ label: string; first: number; second: number; expected: number }> = [
    { label: "forward in time", first: 1000, second: 2000, expected: 2000 },
    { label: "backwards (a late batch result)", first: 2000, second: 1000, expected: 2000 },
    { label: "the same instant", first: 1500, second: 1500, expected: 1500 },
    { label: "at epoch zero", first: 0, second: 0, expected: 0 },
  ];

  it.each(anchors)("speech energy moves the anchor only $label", ({ first, second, expected }) => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "SPEECH_ACTIVITY", t: first },
      { type: "SPEECH_ACTIVITY", t: second },
    ]);
    expect(state.lastSpeechT).toBe(expected);
  });

  it("speech energy alone does not clear the network budget — it is not evidence the network works", () => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "ERROR", t: 100, error: "network" },
      { type: "SPEECH_ACTIVITY", t: 200 },
      { type: "ERROR", t: 300, error: "network" },
    ]);
    expect(state.phase).toBe("failed");
    expect(state.failReason).toBe("network");
  });

  it("an INTERIM result does clear the budget — words arrived, so the engine is alive", () => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "ERROR", t: 100, error: "network" },
      { type: "RESULT", t: 200, text: "still here", isFinal: false },
      { type: "ERROR", t: 300, error: "network" },
    ]);
    expect(state.phase).toBe("listening");
    expect(state.consecutiveNetworkErrors).toBe(1);
  });

  const errorRuns: Array<{ label: string; errors: string[]; phase: SttState["phase"]; reason: string | null }> = [
    { label: "no-speech spam is silence, not failure", errors: Array(8).fill("no-speech"), phase: "listening", reason: null },
    { label: "aborted spam is our own stop() calls", errors: Array(8).fill("aborted"), phase: "listening", reason: null },
    { label: "one network error is survivable", errors: ["network"], phase: "listening", reason: null },
    { label: "soft noise does not clear the network budget", errors: ["network", "no-speech", "network"], phase: "failed", reason: "network" },
    { label: "a network error after an abort still degrades", errors: ["aborted", "network", "network"], phase: "failed", reason: "network" },
    { label: "mixed transcription failures accumulate together", errors: ["cloud_transcribe", "whisper_failed", "transcribe_failed"], phase: "failed", reason: "transcribe_failed" },
    { label: "two transcription failures are a hiccup", errors: ["cloud_transcribe", "cloud_transcribe"], phase: "listening", reason: null },
    { label: "no-speech between transcription failures does not reset them", errors: ["cloud_transcribe", "no-speech", "cloud_transcribe", "aborted", "cloud_transcribe"], phase: "failed", reason: "cloud_transcribe" },
    { label: "a permission denial degrades on the first one", errors: ["not-allowed"], phase: "failed", reason: "not-allowed" },
    { label: "a policy-blocked mic degrades on the first one", errors: ["service-not-allowed"], phase: "failed", reason: "service-not-allowed" },
    { label: "a missing input device degrades on the first one", errors: ["audio-capture"], phase: "failed", reason: "audio-capture" },
    { label: "an unknown code is treated as an engine failure, not as noise", errors: ["quota-exceeded", "quota-exceeded", "quota-exceeded"], phase: "failed", reason: "quota-exceeded" },
    { label: "one unknown code alone keeps the mic", errors: ["quota-exceeded"], phase: "listening", reason: null },
    { label: "an engine that reports an empty code still hands over", errors: ["", "", ""], phase: "failed", reason: "" },
  ];

  it.each(errorRuns)("$label", ({ errors, phase, reason }) => {
    const actions: SttAction[] = [{ type: "START", t: 0 }];
    errors.forEach((error, i) => actions.push({ type: "ERROR", t: 100 + i, error }));
    const { state } = drive(actions);
    expect(state.phase).toBe(phase);
    expect(state.failReason).toBe(reason);
  });

  it("the three error budgets are tracked independently", () => {
    const { state } = drive([
      { type: "START", t: 0 },
      { type: "ERROR", t: 100, error: "no-speech" },
      { type: "ERROR", t: 200, error: "network" },
      { type: "ERROR", t: 300, error: "cloud_transcribe" },
    ]);
    expect(state.phase).toBe("listening");
    expect(state.consecutiveErrors).toBe(3);
    expect(state.consecutiveNetworkErrors).toBe(1);
    expect(state.consecutiveEngineErrors).toBe(1);
  });

  const everyAction: Array<{ label: string; action: SttAction }> = [
    { label: "START", action: { type: "START", t: 900 } },
    { label: "RESULT (interim)", action: { type: "RESULT", t: 900, text: "more", isFinal: false } },
    { label: "RESULT (final)", action: { type: "RESULT", t: 900, text: "more", isFinal: true } },
    { label: "SPEECH_ACTIVITY", action: { type: "SPEECH_ACTIVITY", t: 900 } },
    { label: "ENGINE_END", action: { type: "ENGINE_END", t: 900 } },
    { label: "ERROR", action: { type: "ERROR", t: 900, error: "network" } },
    { label: "STOP", action: { type: "STOP", t: 900 } },
  ];

  it.each(everyAction)("$label never mutates the state handed to it", ({ action }) => {
    // The hooks keep the previous state around (React refs, the trace buffer
    // saved with the session). In-place mutation would rewrite history.
    const prev = drive([
      { type: "START", t: 0 },
      { type: "RESULT", t: 100, text: "captured", isFinal: true },
      { type: "RESULT", t: 200, text: "live fragment", isFinal: false },
    ]).state;
    Object.freeze(prev.finalSegments);
    Object.freeze(prev.trace);
    Object.freeze(prev);

    const out = sttReduce(prev, action);
    expect(out.state).not.toBe(prev);
    expect(prev.finalSegments).toEqual(["captured"]);
    expect(prev.interim).toBe("live fragment");
    expect(prev.trace).toHaveLength(3);
  });
});

// ———————————————————————————————————————————————————————————————
// VAD boundaries
// ———————————————————————————————————————————————————————————————

// The VAD is the first link in the reply chain: nothing is transcribed, and so
// nothing can be answered, until a segment closes. Each threshold here is a
// decision about somebody's sentence — cut too early and the answer is halved,
// too late and the interviewer talks over them.

describe("VAD: the enter/exit hysteresis boundaries", () => {
  const entering: Array<{ label: string; rms: number; enters: boolean }> = [
    { label: "exactly at enterRms", rms: DEFAULT_VAD.enterRms, enters: true },
    { label: "a hair below enterRms", rms: DEFAULT_VAD.enterRms - 0.0001, enters: false },
    { label: "well above enterRms", rms: LOUD, enters: true },
    { label: "between the two thresholds", rms: MID, enters: false },
    { label: "exactly at exitRms", rms: DEFAULT_VAD.exitRms, enters: false },
    { label: "digital silence", rms: 0, enters: false },
    { label: "a negative (impossible) level", rms: -1, enters: false },
    { label: "NaN from an empty audio block", rms: NaN, enters: false },
    { label: "a clipped/infinite level", rms: Infinity, enters: true },
  ];

  it.each(entering)("silence → speech: $label", ({ rms, enters }) => {
    const { state, events } = feed([[rms, 0]]);
    expect(state.speaking).toBe(enters);
    expect(state.segmentStartT).toBe(enters ? 0 : null);
    expect(events).toEqual(enters ? [{ kind: "activity", t: 0 }] : []);
  });

  const exiting: Array<{ label: string; rms: number; stays: boolean }> = [
    { label: "exactly at exitRms keeps the sentence alive", rms: DEFAULT_VAD.exitRms, stays: true },
    { label: "a hair below exitRms ends it", rms: DEFAULT_VAD.exitRms - 0.0001, stays: false },
    { label: "mid-level speech keeps it alive", rms: MID, stays: true },
    { label: "digital silence ends it", rms: 0, stays: false },
    { label: "NaN ends it rather than hanging on", rms: NaN, stays: false },
  ];

  it.each(exiting)("speech → silence: $label", ({ rms, stays }) => {
    const { state, events } = feed([
      [LOUD, 0],
      [rms, 100],
    ]);
    expect(state.speaking).toBe(stays);
    // The endpoint of the segment is the last AUDIBLE block, never the silent one.
    expect(state.lastSpeechT).toBe(stays ? 100 : 0);
    expect(activityOf(events)).toHaveLength(stays ? 2 : 1);
  });

  it("a level between the thresholds can hold a sentence open but can never open one", () => {
    const held = feed([
      [LOUD, 0],
      [MID, 400],
      [MID, 800],
      [QUIET, 900],
      [QUIET, 1500],
    ]);
    expect(segmentsOf(held.events)).toEqual([{ kind: "segment", startT: 0, endT: 800 }]);

    const never = feed(Array.from({ length: 40 }, (_, i): [number, number] => [MID, i * 750]));
    expect(never.events).toEqual([]);
    expect(never.state.lastSpeechT).toBeNull(); // no SPEECH_ACTIVITY reaches the reducer either
    expect(never.state.segmentStartT).toBeNull();
  });
});

describe("VAD: where a segment is cut", () => {
  it("cuts at exactly silenceCutMs, not a block earlier", () => {
    const justShort = feed([
      [LOUD, 0],
      [LOUD, 400],
      [QUIET, 500],
      [QUIET, 400 + DEFAULT_VAD.silenceCutMs - 1],
    ]);
    expect(segmentsOf(justShort.events)).toEqual([]);

    const exact = feed([
      [LOUD, 0],
      [LOUD, 400],
      [QUIET, 500],
      [QUIET, 400 + DEFAULT_VAD.silenceCutMs],
    ]);
    expect(segmentsOf(exact.events)).toEqual([{ kind: "segment", startT: 0, endT: 400 }]);
  });

  it("the block that first drops below exitRms never cuts — the cut needs the block after it", () => {
    // Harmless in the real engine (blocks arrive every ~85ms) but it is why
    // stop() has to flush the pending segment itself instead of trusting the
    // VAD to have closed it.
    const { events } = feed([
      [LOUD, 0],
      [LOUD, 400],
      [QUIET, 9000], // 8.6s of silence in one block: still no cut
    ]);
    expect(segmentsOf(events)).toEqual([]);
  });

  it("a segment exactly minSegmentMs long is speech; one millisecond shorter is noise", () => {
    const kept = feed([
      [LOUD, 0],
      [LOUD, DEFAULT_VAD.minSegmentMs],
      [QUIET, DEFAULT_VAD.minSegmentMs + DEFAULT_VAD.silenceCutMs],
      [QUIET, DEFAULT_VAD.minSegmentMs + DEFAULT_VAD.silenceCutMs + 1],
    ]);
    expect(segmentsOf(kept.events)).toEqual([{ kind: "segment", startT: 0, endT: DEFAULT_VAD.minSegmentMs }]);

    const dropped = feed([
      [LOUD, 0],
      [LOUD, DEFAULT_VAD.minSegmentMs - 1],
      [QUIET, DEFAULT_VAD.minSegmentMs + DEFAULT_VAD.silenceCutMs],
      [QUIET, DEFAULT_VAD.minSegmentMs + DEFAULT_VAD.silenceCutMs + 1],
    ]);
    expect(segmentsOf(dropped.events)).toEqual([]);
  });

  it("a dropped noise blip clears the pending segment so the real answer starts at its own onset", () => {
    // Without this the door-slam at t=0 would prepend two seconds of silence to
    // the candidate's first segment — and Whisper hallucinates on silence.
    const { events, state } = feed([
      [LOUD, 0],
      [LOUD, 120], // 120ms blip: dropped
      [QUIET, 800],
      [QUIET, 900],
      [QUIET, 1500],
      [LOUD, 2000], // the candidate actually starts
      [LOUD, 2600],
      [QUIET, 2700],
      [QUIET, 3300],
    ]);
    expect(segmentsOf(events)).toEqual([{ kind: "segment", startT: 2000, endT: 2600 }]);
    expect(state.segmentStartT).toBeNull();
  });

  it("silence that keeps going does not cut a second, empty segment", () => {
    const { events } = feed([
      [LOUD, 0],
      [LOUD, 500],
      [QUIET, 600],
      [QUIET, 1200],
      [QUIET, 2000],
      [QUIET, 5000],
      [QUIET, 20_000],
    ]);
    expect(segmentsOf(events)).toHaveLength(1);
  });

  it("force-cuts at exactly maxSegmentMs, and not one millisecond before", () => {
    const justShort = feed([
      [LOUD, 0],
      [LOUD, DEFAULT_VAD.maxSegmentMs - 1],
    ]);
    expect(segmentsOf(justShort.events)).toEqual([]);

    const exact = feed([
      [LOUD, 0],
      [LOUD, DEFAULT_VAD.maxSegmentMs],
    ]);
    expect(segmentsOf(exact.events)).toEqual([{ kind: "segment", startT: 0, endT: DEFAULT_VAD.maxSegmentMs }]);
    expect(exact.state.segmentStartT).toBe(DEFAULT_VAD.maxSegmentMs); // the next one already runs
  });

  it("a marathon answer is cut into contiguous segments with no audio between them", () => {
    const samples: Array<[number, number]> = [];
    for (let t = 0; t <= 25_000; t += 500) samples.push([LOUD, t]);
    samples.push([QUIET, 25_100], [QUIET, 25_700]);
    const segs = segmentsOf(feed(samples).events);
    expect(segs.map((s) => [s.startT, s.endT])).toEqual([
      [0, 10_000],
      [10_000, 20_000],
      [20_000, 25_000],
    ]);
  });

  it("continuous room noise above the enter threshold is force-cut, never silence-cut", () => {
    // A fan, a projector, a noisy hostel corridor: the level never drops, so
    // the only thing bounding transcription latency is the max-segment cut.
    const samples: Array<[number, number]> = [];
    for (let t = 0; t <= 30_000; t += 250) samples.push([DEFAULT_VAD.enterRms + 0.001, t]);
    const segs = segmentsOf(feed(samples).events);
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.endT - s.startT === DEFAULT_VAD.maxSegmentMs)).toBe(true);
  });

  it("a soft speaker who peaks once still gets one segment ending at their last audible word", () => {
    const samples: Array<[number, number]> = [[DEFAULT_VAD.enterRms, 0]];
    for (let t = 200; t <= 4000; t += 200) samples.push([MID, t]);
    samples.push([QUIET, 4200], [QUIET, 4800]);
    expect(segmentsOf(feed(samples).events)).toEqual([{ kind: "segment", startT: 0, endT: 4000 }]);
  });

  it("honours a custom config instead of the defaults", () => {
    const eager: VadConfig = { ...DEFAULT_VAD, silenceCutMs: 0, minSegmentMs: 0 };
    const { events } = feed(
      [
        [LOUD, 0],
        [QUIET, 1],
        [QUIET, 2],
      ],
      eager,
    );
    expect(segmentsOf(events)).toEqual([{ kind: "segment", startT: 0, endT: 0 }]);

    const patient: VadConfig = { ...DEFAULT_VAD, silenceCutMs: 5_000 };
    const late = feed(
      [
        [LOUD, 0],
        [LOUD, 400],
        [QUIET, 500],
        [QUIET, 3_000],
      ],
      patient,
    );
    expect(segmentsOf(late.events)).toEqual([]);
  });

  it("vadStep never mutates the state handed to it", () => {
    const prev = feed([[LOUD, 0]]).state;
    Object.freeze(prev);
    const out = vadStep(prev, QUIET, 100, DEFAULT_VAD);
    expect(out.state).not.toBe(prev);
    expect(prev.speaking).toBe(true);
    expect(prev.lastSpeechT).toBe(0);
  });
});

// ———————————————————————————————————————————————————————————————
// Barge-in
// ———————————————————————————————————————————————————————————————

// The mic is live by default and most candidates demo without headphones, so
// the interviewer's own voice is in every transcript. A false interrupt (her
// question cutting itself off) is far worse than a missed one. Each defense
// below is one threshold; these pin both sides of every one of them.

describe("barge-in: her own voice can never take the floor", () => {
  const ackLines = Object.values(ACK_TEXTS).flat();
  const echoRef = `${PRIYA} ${ackLines.join(" ")}`;

  const echoes: Array<{ label: string; heard: string }> = [
    { label: "the whole question verbatim", heard: PRIYA },
    { label: "the question with no punctuation and no case", heard: PRIYA.toUpperCase().replace(/[.?,]/g, "") },
    { label: "the opening half of the question", heard: "tell me about a time you worked in a team" },
    { label: "the closing half of the question", heard: "and things did not go smoothly what did you do" },
    { label: "the question with a couple of words garbled", heard: "tell me about a time you worked in a teen and things did not go smoothie" },
    { label: "the question heard twice through the speakers", heard: `${PRIYA} ${PRIYA}` },
    { label: "the question padded with backchannel", heard: `yeah okay ${PRIYA} right mm-hm` },
  ];

  it.each(echoes)("$label is echo, not an interruption", ({ heard }) => {
    expect(decideBargeIn({ heardText: heard, spokenText: echoRef, msSinceTtsStart: 4000 })).toBe("ignore");
  });

  it.each(ackLines.map((line) => ({ line })))("the ack line %s is never an interruption", ({ line }) => {
    expect(decideBargeIn({ heardText: line, spokenText: echoRef, msSinceTtsStart: 4000 })).toBe("ignore");
  });

  it("every ack line, heard as one run, is still echo", () => {
    expect(decideBargeIn({ heardText: ackLines.join(" "), spokenText: echoRef, msSinceTtsStart: 4000 })).toBe("ignore");
  });

  it("the ack lines MUST be in the echo reference — the rephrase nudge clears every bar without them", () => {
    // Regression guard for the wiring in useInterviewMachine (echoRefText =
    // turn text + ALL_ACK_LINES). With only the question as reference, the
    // room's own "Want me to rephrase that?" comes back through the speakers
    // and interrupts the room.
    const nudge = ACK_TEXTS.rephrase[0];
    expect(decideBargeIn({ heardText: nudge, spokenText: PRIYA, msSinceTtsStart: 4000 })).toBe("interrupt");
    expect(decideBargeIn({ heardText: nudge, spokenText: echoRef, msSinceTtsStart: 4000 })).toBe("ignore");
  });
});

describe("barge-in: the warm-up guard", () => {
  const genuine = "actually sorry can I answer the previous question differently";

  const windows: Array<{ label: string; ms: number; expected: "interrupt" | "ignore" }> = [
    { label: "the very first syllable", ms: 0, expected: "ignore" },
    { label: "a clock that ran backwards", ms: -500, expected: "ignore" },
    { label: "one millisecond before the window closes", ms: BARGE_IN_WARMUP_MS - 1, expected: "ignore" },
    { label: "exactly when the window closes", ms: BARGE_IN_WARMUP_MS, expected: "interrupt" },
    { label: "well past the window", ms: 8000, expected: "interrupt" },
  ];

  it.each(windows)("$label → $expected", ({ ms, expected }) => {
    expect(decideBargeIn({ heardText: genuine, spokenText: PRIYA, msSinceTtsStart: ms })).toBe(expected);
  });

  it("the guard is not a substitute for the echo filter: her words never interrupt, however late", () => {
    expect(decideBargeIn({ heardText: PRIYA, spokenText: PRIYA, msSinceTtsStart: 60_000 })).toBe("ignore");
  });
});

describe("barge-in: the substance thresholds", () => {
  it("a phrase of exactly MIN_INTERRUPT_CHARS takes the floor; one character less does not", () => {
    const exact = "we shipped it on tuesday";
    const short = "we shipped it on monday";
    expect(exact).toHaveLength(MIN_INTERRUPT_CHARS);
    expect(short).toHaveLength(MIN_INTERRUPT_CHARS - 1);
    expect(decideBargeIn({ heardText: exact, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("interrupt");
    expect(decideBargeIn({ heardText: short, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("ignore");
  });

  it("surrounding whitespace does not buy a fragment past the length bar", () => {
    expect(
      decideBargeIn({ heardText: "          no wait          ", spokenText: PRIYA, msSinceTtsStart: 3000 }),
    ).toBe("ignore");
  });

  it("a long phrase with too few real words is still not an interruption", () => {
    const fourWords = "kubernetes crashed again today";
    expect(fourWords.length).toBeGreaterThan(MIN_INTERRUPT_CHARS);
    expect(decideBargeIn({ heardText: fourWords, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("ignore");
    expect(decideBargeIn({ heardText: `${fourWords} anyway`, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("interrupt");
  });

  it("single letters are recogniser debris and do not count toward the word bar", () => {
    expect(
      decideBargeIn({ heardText: "kubernetes crashed again today a b c d e", spokenText: PRIYA, msSinceTtsStart: 3000 }),
    ).toBe("ignore");
  });

  it("exactly MIN_INTERRUPT_NOVEL_WORDS of her own content is enough; one is not", () => {
    const two = "yeah okay so um kubernetes crashed";
    const one = "yeah okay so um kubernetes right";
    expect(novelWordCount(two, PRIYA)).toBe(MIN_INTERRUPT_NOVEL_WORDS);
    expect(novelWordCount(one, PRIYA)).toBe(MIN_INTERRUPT_NOVEL_WORDS - 1);
    expect(decideBargeIn({ heardText: two, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("interrupt");
    expect(decideBargeIn({ heardText: one, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("ignore");
  });

  const backchannel = [
    "yeah yeah okay right mm-hm okay sure yeah",
    "um uh erm hmm yeah okay so like just really",
    "no no no nope nah okay okay right sure",
  ];

  it.each(backchannel.map((heard) => ({ heard })))("pure backchannel is listening, not interrupting: %s", ({ heard }) => {
    expect(heard.length).toBeGreaterThan(MIN_INTERRUPT_CHARS);
    expect(novelWordCount(heard, PRIYA)).toBe(0);
    expect(decideBargeIn({ heardText: heard, spokenText: PRIYA, msSinceTtsStart: 4000 })).toBe("ignore");
  });
});

describe("barge-in: the echo-overlap and verbatim-run thresholds", () => {
  // Built so the ratio lands exactly on the threshold: 17 of her words spread
  // singly through 33 of theirs, so no verbatim RUN exists to decide it first.
  const SHARED = ["alpha", "bravo", "charlie", "delta", "epsilon", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec"];
  const NOVEL = Array.from({ length: 33 }, (_, i) => `zulu${i}`);
  const spoken = SHARED.join(" ");

  function interleave(shared: string[], novel: string[]): string {
    const out: string[] = [];
    for (let i = 0; i < novel.length; i++) {
      out.push(novel[i]);
      if (i < shared.length) out.push(shared[i]);
    }
    return out.join(" ");
  }

  it("a ratio landing exactly on the threshold is echo (the comparison is inclusive)", () => {
    const heard = interleave(SHARED, NOVEL); // 17 hits / 50 tokens
    expect(echoOverlap(heard, spoken)).toBeCloseTo(ECHO_OVERLAP_THRESHOLD, 10);
    expect(longestSharedRun(heard, spoken)).toBe(1);
    expect(decideBargeIn({ heardText: heard, spokenText: spoken, msSinceTtsStart: 3000 })).toBe("ignore");
  });

  it("one shared word fewer, and the same transcript takes the floor", () => {
    const heard = interleave(SHARED.slice(0, 16), [...NOVEL, "zulu99"]); // 16 hits / 50 tokens
    expect(echoOverlap(heard, spoken)).toBeLessThan(ECHO_OVERLAP_THRESHOLD);
    expect(decideBargeIn({ heardText: heard, spokenText: spoken, msSinceTtsStart: 3000 })).toBe("interrupt");
  });

  it("exactly ECHO_RUN_TOKENS of her words in order is a recording of her, whatever the ratio says", () => {
    const heard = "things did not go kubernetes postgres yesterday morning nightly deploy pipeline broke";
    expect(echoOverlap(heard, PRIYA)).toBeLessThan(ECHO_OVERLAP_THRESHOLD); // the ratio would let it through
    expect(longestSharedRun(heard, PRIYA)).toBe(ECHO_RUN_TOKENS);
    expect(decideBargeIn({ heardText: heard, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("ignore");
  });

  it("one word fewer in the run, and the candidate keeps the floor", () => {
    const heard = "things did not kubernetes postgres yesterday morning nightly deploy pipeline broke";
    expect(longestSharedRun(heard, PRIYA)).toBe(ECHO_RUN_TOKENS - 1);
    expect(decideBargeIn({ heardText: heard, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("interrupt");
  });

  it("the same four words OUT of order are a coincidence, not a recording", () => {
    const heard = "did things go not kubernetes postgres yesterday morning nightly deploy pipeline broke again";
    expect(longestSharedRun(heard, PRIYA)).toBeLessThan(ECHO_RUN_TOKENS);
    expect(decideBargeIn({ heardText: heard, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("interrupt");
  });

  const overlapCases: Array<{ label: string; heard: string; spoken: string; expected: number }> = [
    { label: "empty heard text scores zero, never NaN", heard: "", spoken: PRIYA, expected: 0 },
    { label: "whitespace-only heard text scores zero", heard: "   \n\t", spoken: PRIYA, expected: 0 },
    { label: "punctuation-only heard text scores zero", heard: "!!! ... ???", spoken: PRIYA, expected: 0 },
    { label: "nothing spoken means nothing to echo", heard: "tell me about a time", spoken: "", expected: 0 },
    { label: "a full quote of her line scores one", heard: PRIYA, spoken: PRIYA, expected: 1 },
    { label: "case and punctuation are ignored", heard: "TELL ME, ABOUT!", spoken: PRIYA, expected: 1 },
    { label: "single letters are not tokens", heard: "a i o u", spoken: PRIYA, expected: 0 },
  ];

  it.each(overlapCases)("echoOverlap: $label", ({ heard, spoken: sp, expected }) => {
    expect(echoOverlap(heard, sp)).toBe(expected);
  });

  it("echoOverlap is directional — a short quote inside a long line is not the same question asked back", () => {
    const quote = "worked in a team";
    expect(echoOverlap(quote, PRIYA)).toBe(1);
    expect(echoOverlap(PRIYA, quote)).toBeLessThan(0.5);
  });

  const runCases: Array<{ label: string; heard: string; spoken: string; expected: number }> = [
    { label: "nothing heard", heard: "", spoken: PRIYA, expected: 0 },
    { label: "nothing spoken", heard: PRIYA, spoken: "", expected: 0 },
    { label: "one shared word", heard: "kubernetes team postgres", spoken: PRIYA, expected: 1 },
    { label: "no shared word", heard: "kubernetes postgres redis", spoken: PRIYA, expected: 0 },
    { label: "the entire line quoted back", heard: PRIYA, spoken: PRIYA, expected: 18 },
    { label: "a repeated word does not stack into a run", heard: "team team team team", spoken: PRIYA, expected: 1 },
  ];

  it.each(runCases)("longestSharedRun: $label", ({ heard, spoken: sp, expected }) => {
    expect(longestSharedRun(heard, sp)).toBe(expected);
  });

  const novelCases: Array<{ label: string; heard: string; expected: number }> = [
    { label: "her words are not theirs", heard: "worked in a team", expected: 0 },
    { label: "filler is not content", heard: "yeah okay so um right", expected: 0 },
    { label: "content survives the filler around it", heard: "um so basically kubernetes", expected: 1 },
    { label: "duplicates each count (a stutter is still content)", heard: "kubernetes kubernetes", expected: 2 },
    { label: "nothing heard", heard: "", expected: 0 },
    { label: "a non-Latin transcript carries no countable words", heard: "मैं ठीक हूँ", expected: 0 },
  ];

  it.each(novelCases)("novelWordCount: $label", ({ heard, expected }) => {
    expect(novelWordCount(heard, PRIYA)).toBe(expected);
  });
});

describe("barge-in: hostile and degenerate transcripts", () => {
  const degenerate: Array<{ label: string; heard: string }> = [
    { label: "an empty transcript", heard: "" },
    { label: "whitespace only", heard: "               \n\t   " },
    { label: "punctuation only", heard: "........................" },
    { label: "emoji only", heard: "🎤🎤🎤🎤🎤🎤🎤🎤🎤🎤🎤🎤🎤🎤" },
    { label: "a non-Latin transcript (the recogniser is en-IN)", heard: "नमस्ते मैं ठीक हूँ धन्यवाद बहुत" },
    { label: "single letters only", heard: "a b c d e f g h i j k l m n" },
  ];

  it.each(degenerate)("$label never takes the floor", ({ heard }) => {
    expect(decideBargeIn({ heardText: heard, spokenText: PRIYA, msSinceTtsStart: 9000 })).toBe("ignore");
  });

  it("injection-looking text is treated as ordinary words, not markup", () => {
    const heard = "<script>alert('please stop the question')</script>";
    expect(decideBargeIn({ heardText: heard, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("interrupt");
    expect(decideBargeIn({ heardText: "'; DROP TABLE sessions; --", spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("ignore");
  });

  it("a very long genuine monologue still interrupts, and a very long echo still does not", () => {
    const monologue = "kubernetes deployment rollback across regions ".repeat(220);
    expect(monologue.length).toBeGreaterThan(9_000);
    expect(decideBargeIn({ heardText: monologue, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("interrupt");

    const looping = `${PRIYA} `.repeat(100);
    expect(decideBargeIn({ heardText: looping, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("ignore");
  });
});

describe("dropSelfEcho: the window into the transcript", () => {
  const HER = "tell me about a time you worked in a team";
  const THEM = "so my final year project was a placement day simulator";

  const windows: Array<{ label: string; segments: string[]; upto: number; expected: string[] }> = [
    { label: "no segments at all", segments: [], upto: 3, expected: [] },
    { label: "a window of zero touches nothing", segments: [HER, THEM], upto: 0, expected: [HER, THEM] },
    { label: "a negative window touches nothing", segments: [HER, THEM], upto: -1, expected: [HER, THEM] },
    { label: "a window past the end checks every segment", segments: [HER, THEM], upto: 99, expected: [THEM] },
    { label: "order survives the filter", segments: [THEM, HER, THEM, HER], upto: 4, expected: [THEM, THEM] },
    { label: "an empty segment carries no evidence of echo and is kept", segments: ["", HER], upto: 2, expected: [""] },
  ];

  it.each(windows)("$label", ({ segments, upto, expected }) => {
    expect(dropSelfEcho(segments, PRIYA, upto)).toEqual(expected);
  });

  it("never mutates the caller's array — the reducer state owns it", () => {
    const segments = [HER, THEM];
    const out = dropSelfEcho(segments, PRIYA, 2);
    expect(out).not.toBe(segments);
    expect(segments).toEqual([HER, THEM]);
  });
});

// ———————————————————————————————————————————————————————————————
// The Chrome adapter
// ———————————————————————————————————————————————————————————————

// The thin layer between Chrome's callbacks and the reducer: it is where a
// restart actually creates a new recogniser, where a degrade aborts the mic,
// and where the post-stop final result is either kept or thrown away. None of
// this is exercised by the reducer tests, and all of it is timing-shaped.

type SpeechResultLike = { isFinal: boolean; 0: { transcript: string } };
type ResultEvent = { resultIndex: number; results: ArrayLike<SpeechResultLike> };

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static startThrows = false;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((e: ResultEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  started = 0;
  stopCalls = 0;
  abortCalls = 0;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start(): void {
    if (FakeRecognition.startThrows) throw new Error("already started");
    this.started++;
  }
  stop(): void {
    this.stopCalls++;
  }
  abort(): void {
    this.abortCalls++;
  }
}

function batch(resultIndex: number, items: Array<[string, boolean]>): ResultEvent {
  return { resultIndex, results: items.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) };
}

describe("startChromeStt: driving the real adapter with a scripted recogniser", () => {
  let updates: SttState[];
  let degrades: string[];

  const open = () => {
    updates = [];
    degrades = [];
    return startChromeStt({ onUpdate: (s) => updates.push(s), onDegrade: (r) => degrades.push(r) });
  };
  const last = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];

  beforeEach(() => {
    FakeRecognition.instances = [];
    FakeRecognition.startThrows = false;
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("configures the recogniser for a whole answer, not one phrase", () => {
    // continuous:false would end recognition at the first pause; interim
    // results are what the live caption and the silence anchor both run on.
    open();
    expect(last().continuous).toBe(true);
    expect(last().interimResults).toBe(true);
    expect(last().lang).toBe("en-IN");
    expect(last().started).toBe(1);
  });

  it("dispatches only the results at or after resultIndex", () => {
    // Chrome re-sends the whole results list every time; anything before
    // resultIndex was already dispatched and would be recorded twice.
    const sess = open()!;
    last().onresult!(batch(0, [["first sentence", true]]));
    last().onresult!(batch(1, [["first sentence", true], ["second sentence", true]]));
    expect(fullTranscript(sess.getState())).toBe("first sentence second sentence");
  });

  it("delivers a batch that carries a final and the next interim together", () => {
    const sess = open()!;
    last().onresult!(batch(0, [["I finished that thought", true], ["and I am still", false]]));
    const st = sess.getState();
    expect(st.finalSegments).toEqual(["I finished that thought"]);
    expect(st.interim).toBe("and I am still");
    expect(fullTranscript(st)).toBe("I finished that thought and I am still");
  });

  it("shows interim text to the caller before anything is finalized", () => {
    open();
    last().onresult!(batch(0, [["half a sen", false]]));
    expect(updates[updates.length - 1].interim).toBe("half a sen");
    expect(updates[updates.length - 1].finalSegments).toEqual([]);
  });

  it("an engine auto-stop builds a NEW recogniser and keeps the transcript", () => {
    const sess = open()!;
    last().onresult!(batch(0, [["my name is hari", true]]));
    last().onend!(); // Chrome's ~60s auto-stop
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(last().started).toBe(1);
    last().onresult!(batch(0, [["and I study CS", true]]));
    expect(fullTranscript(sess.getState())).toBe("my name is hari and I study CS");
    expect(sess.getState().restartCount).toBe(1);
  });

  it("stop() ends the session for good — a later engine end restarts nothing", () => {
    const sess = open()!;
    sess.stop();
    expect(last().stopCalls).toBe(1);
    last().onend!();
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(sess.getState().phase).toBe("stopped");
  });

  it("keeps its handlers attached after stop() so the buffered final still lands", () => {
    const sess = open()!;
    last().onresult!(batch(0, [["my final answer is", false]]));
    const atStop = sess.stop();
    expect(fullTranscript(atStop)).toBe("my final answer is");
    last().onresult!(batch(0, [["My final answer is teamwork.", true]]));
    expect(fullTranscript(sess.getState())).toBe("My final answer is teamwork."); // merged, not duplicated
  });

  it("stopAndSettle waits for the late final instead of returning the clipped answer", async () => {
    const sess = open()!;
    last().onresult!(batch(0, [["the whole point of my project was", false]]));
    const settling = sess.stopAndSettle(25);
    last().onresult!(batch(0, [["the whole point of my project was scale", true]]));
    const settled = await settling;
    expect(fullTranscript(settled)).toBe("the whole point of my project was scale");
  });

  it("a fatal error aborts the mic, degrades once, and never restarts", () => {
    const sess = open()!;
    last().onerror!({ error: "not-allowed" });
    expect(degrades).toEqual(["not-allowed"]);
    expect(last().abortCalls).toBe(1);
    last().onend!();
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(sess.getState().phase).toBe("failed");
  });

  it("survives Chrome's no-speech/aborted spam without degrading", () => {
    const sess = open()!;
    for (let i = 0; i < 6; i++) {
      last().onerror!({ error: i % 2 === 0 ? "no-speech" : "aborted" });
      last().onend!();
    }
    expect(degrades).toEqual([]);
    expect(sess.getState().phase).toBe("listening");
  });

  it("degrades on the second consecutive network error and stops rebuilding recognisers", () => {
    open();
    last().onerror!({ error: "network" });
    last().onend!();
    expect(FakeRecognition.instances).toHaveLength(2);
    last().onerror!({ error: "network" });
    expect(degrades).toEqual(["network"]);
    const built = FakeRecognition.instances.length;
    last().onend!();
    expect(FakeRecognition.instances).toHaveLength(built);
  });

  it("a recogniser that refuses to start degrades instead of pretending to listen", () => {
    FakeRecognition.startThrows = true;
    const sess = open();
    expect(sess).toBeNull();
    expect(degrades).toEqual(["start_failed"]);
  });

  it("a browser with no recogniser degrades before touching any state", () => {
    vi.stubGlobal("window", {});
    const sess = open();
    expect(sess).toBeNull();
    expect(degrades).toEqual(["unsupported"]);
    expect(updates).toEqual([]);
  });

  it("uses Safari's webkit-prefixed constructor when that is all there is", () => {
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition });
    const sess = open()!;
    expect(sess).not.toBeNull();
    last().onresult!(batch(0, [["safari works too", true]]));
    expect(fullTranscript(sess.getState())).toBe("safari works too");
  });
});

// ———————————————————————————————————————————————————————————————
// Engine selection
// ———————————————————————————————————————————————————————————————

// Which engine transcribes an answer, under every combination of what the
// server and the browser can offer. The order is by ACCURACY: Chrome mangles
// Indian-accented English, so it only wins when nothing better exists — and a
// mid-session degrade must never route back to the engine that just broke.

type Caps = { cloud: string | null; deepgramLive: boolean };
type Engine = "deepgram" | "cloud" | "chrome" | "whisper";

async function freshStt(caps: Caps, recognizer: "SpeechRecognition" | "webkitSpeechRecognition" | null) {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => caps }) as unknown as Response);
  if (recognizer) vi.stubGlobal("window", { [recognizer]: class {} });
  const mod = await import("@/lib/stt");
  await mod.resolveSttCapabilities();
  return mod;
}

describe("pickSttEngine / nextSttEngine: the full capability matrix", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const matrix: Array<{ label: string; caps: Caps; recognizer: boolean; chain: Engine[] }> = [
    { label: "live streaming + cloud + a browser recogniser", caps: { cloud: "deepgram", deepgramLive: true }, recognizer: true, chain: ["deepgram", "cloud", "chrome", "whisper"] },
    { label: "live streaming + cloud, no browser recogniser", caps: { cloud: "deepgram", deepgramLive: true }, recognizer: false, chain: ["deepgram", "cloud", "whisper"] },
    { label: "live streaming only, with a browser recogniser", caps: { cloud: null, deepgramLive: true }, recognizer: true, chain: ["deepgram", "chrome", "whisper"] },
    { label: "live streaming only, nothing else", caps: { cloud: null, deepgramLive: true }, recognizer: false, chain: ["deepgram", "whisper"] },
    { label: "cloud transcription + a browser recogniser", caps: { cloud: "groq", deepgramLive: false }, recognizer: true, chain: ["cloud", "chrome", "whisper"] },
    { label: "cloud transcription in a browser with no recogniser", caps: { cloud: "groq", deepgramLive: false }, recognizer: false, chain: ["cloud", "whisper"] },
    { label: "no server keys, but Chrome is here", caps: { cloud: null, deepgramLive: false }, recognizer: true, chain: ["chrome", "whisper"] },
    { label: "nothing at all — the on-device model", caps: { cloud: null, deepgramLive: false }, recognizer: false, chain: ["whisper"] },
  ];

  it.each(matrix)("$label", async ({ caps, recognizer, chain }) => {
    const stt = await freshStt(caps, recognizer ? "SpeechRecognition" : null);
    expect(stt.pickSttEngine()).toBe(chain[0]);
    for (const failed of ["deepgram", "cloud", "chrome", "whisper"] as Engine[]) {
      expect(stt.nextSttEngine(failed)).toBe(chain.find((c) => c !== failed) ?? null);
    }
  });

  it("Safari's prefixed recogniser counts as a browser recogniser", async () => {
    const stt = await freshStt({ cloud: null, deepgramLive: false }, "webkitSpeechRecognition");
    expect(stt.pickSttEngine()).toBe("chrome");
  });

  it("an explicit choice wins even when the server says that engine does not exist", async () => {
    // The user picked it in settings, or a degrade routed here on purpose.
    const stt = await freshStt({ cloud: null, deepgramLive: false }, "SpeechRecognition");
    stt.setSttEngineEphemeral("cloud");
    expect(stt.pickSttEngine()).toBe("cloud");
    stt.setSttEngineEphemeral(null);
    expect(stt.pickSttEngine()).toBe("chrome");
  });
});

describe("resolveSttCapabilities: the probe is one GET, and every failure is survivable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caches for the visit — a second call makes no second request", async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return { ok: true, json: async () => ({ cloud: "groq", deepgramLive: false }) } as unknown as Response;
    });
    const stt = await import("@/lib/stt");
    expect(stt.sttCapabilities()).toBeNull(); // nothing probed yet
    const first = await stt.resolveSttCapabilities();
    const second = await stt.resolveSttCapabilities();
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(stt.sttCapabilities()).toEqual({ cloud: "groq", deepgramLive: false });
  });

  const failures: Array<{ label: string; respond: () => Promise<unknown> }> = [
    { label: "the endpoint 500s", respond: async () => ({ ok: false, status: 500, json: async () => ({}) }) },
    { label: "the browser is offline", respond: async () => { throw new Error("offline"); } },
    { label: "the body is not JSON", respond: async () => ({ ok: true, json: async () => { throw new SyntaxError("unexpected token"); } }) },
    { label: "the body is an empty object", respond: async () => ({ ok: true, json: async () => ({}) }) },
    { label: "the body is null", respond: async () => ({ ok: true, json: async () => null }) },
  ];

  it.each(failures)("$label leaves the browser engines in charge", async ({ respond }) => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", respond as unknown as typeof fetch);
    vi.stubGlobal("window", { SpeechRecognition: class {} });
    const stt = await import("@/lib/stt");
    expect(await stt.resolveSttCapabilities()).toEqual({ cloud: null, deepgramLive: false });
    expect(stt.pickSttEngine()).toBe("chrome");
  });

  it("an empty provider string is no provider — Chrome keeps the round", async () => {
    const stt = await freshStt({ cloud: "", deepgramLive: false }, "SpeechRecognition");
    expect(stt.sttCapabilities()).toEqual({ cloud: "", deepgramLive: false });
    expect(stt.pickSttEngine()).toBe("chrome");
  });

  it("a truthy non-boolean deepgramLive is coerced, not trusted raw", async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ cloud: null, deepgramLive: "yes" }) }) as unknown as Response);
    const stt = await import("@/lib/stt");
    const caps = await stt.resolveSttCapabilities();
    expect(caps.deepgramLive).toBe(true);
    expect(stt.pickSttEngine()).toBe("deepgram");
  });
});

describe("getSttEngine: the stored preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stored: Array<{ label: string; value: string | null; expected: string }> = [
    { label: "chrome", value: "chrome", expected: "chrome" },
    { label: "whisper", value: "whisper", expected: "whisper" },
    { label: "cloud", value: "cloud", expected: "cloud" },
    { label: "deepgram", value: "deepgram", expected: "deepgram" },
    { label: "nothing stored", value: null, expected: "auto" },
    { label: "the explicit auto value", value: "auto", expected: "auto" },
    { label: "a stale engine name from an older build", value: "vosk", expected: "auto" },
    { label: "an empty string", value: "", expected: "auto" },
    { label: "a case variant", value: "Chrome", expected: "auto" },
    { label: "a JSON blob someone else wrote to the key", value: '{"engine":"chrome"}', expected: "auto" },
  ];

  it.each(stored)("$label → $expected", async ({ value, expected }) => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("window", { localStorage: { getItem: () => value, setItem: () => {} } });
    const stt = await import("@/lib/stt");
    expect(stt.getSttEngine()).toBe(expected);
  });

  it("a browser that throws on storage access (private mode, blocked cookies) still runs", async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new DOMException("denied");
        },
        setItem: () => {
          throw new DOMException("denied");
        },
      },
    });
    const stt = await import("@/lib/stt");
    expect(stt.getSttEngine()).toBe("auto");
    expect(() => stt.setSttEngine("whisper")).not.toThrow();
  });
});

describe("sttProvider / deepgramLiveEnabled: what the capability probe reports", () => {
  const KEYS = ["GROQ_API_KEY", "OPENAI_API_KEY", "DEEPGRAM_API_KEY", "STT_PROVIDER", "DEEPGRAM_LIVE"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const providers: Array<{ label: string; env: Record<string, string>; expected: string | null }> = [
    { label: "all three keys → the fastest free tier wins", env: { GROQ_API_KEY: "g", OPENAI_API_KEY: "o", DEEPGRAM_API_KEY: "d" }, expected: "groq" },
    { label: "only OpenAI", env: { OPENAI_API_KEY: "o" }, expected: "openai" },
    { label: "only Deepgram", env: { DEEPGRAM_API_KEY: "d" }, expected: "deepgram" },
    { label: "an explicit preference that has a key", env: { GROQ_API_KEY: "g", OPENAI_API_KEY: "o", STT_PROVIDER: "openai" }, expected: "openai" },
    { label: "a preference whose key is missing falls back", env: { GROQ_API_KEY: "g", STT_PROVIDER: "openai" }, expected: "groq" },
    { label: "a preference that is not a provider at all", env: { GROQ_API_KEY: "g", STT_PROVIDER: "assemblyai" }, expected: "groq" },
    { label: "a key that is only whitespace does not count", env: { GROQ_API_KEY: "   ", OPENAI_API_KEY: "o" }, expected: "openai" },
    { label: "an empty key does not count", env: { GROQ_API_KEY: "", DEEPGRAM_API_KEY: "d" }, expected: "deepgram" },
    { label: "no keys at all", env: {}, expected: null },
  ];

  it.each(providers)("$label", ({ env, expected }) => {
    Object.assign(process.env, env);
    expect(sttProvider()).toBe(expected);
  });

  const live: Array<{ label: string; env: Record<string, string>; expected: boolean }> = [
    { label: "a Deepgram key alone enables live streaming", env: { DEEPGRAM_API_KEY: "d" }, expected: true },
    { label: "DEEPGRAM_LIVE=0 is the kill switch", env: { DEEPGRAM_API_KEY: "d", DEEPGRAM_LIVE: "0" }, expected: false },
    { label: "DEEPGRAM_LIVE=1 is explicit consent", env: { DEEPGRAM_API_KEY: "d", DEEPGRAM_LIVE: "1" }, expected: true },
    { label: "no key means no live streaming, whatever the flag says", env: { DEEPGRAM_LIVE: "1" }, expected: false },
    { label: "a whitespace key is no key", env: { DEEPGRAM_API_KEY: "  " }, expected: false },
  ];

  it.each(live)("$label", ({ env, expected }) => {
    Object.assign(process.env, env);
    expect(deepgramLiveEnabled()).toBe(expected);
  });
});

// ———————————————————————————————————————————————————————————————
// Degrade copy
// ———————————————————————————————————————————————————————————————

// Every degrade reason the listening pipeline can emit ends up in front of a
// student mid-interview. A raw code ("whisper_loading") on screen is the
// failure mode this module exists to prevent.

describe("micHelp: every degrade code the pipeline can emit", () => {
  const CODES = [
    "unsupported",
    "not-allowed",
    "service-not-allowed",
    "audio-capture",
    "network",
    "whisper_loading",
    "whisper_failed",
    "cloud_transcribe",
    "transcribe_failed",
    "too_many_restarts",
    "start_failed",
  ];

  it.each(CODES.map((code) => ({ code })))("%s never leaks its raw code to the candidate", ({ code }) => {
    for (const opts of [{}, { cloudStt: true }]) {
      const msg = micHelp(code, opts);
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).not.toContain(code);
      expect(msg).not.toMatch(/_/); // no snake_case identifier survived into the copy
    }
  });

  it("only the two engine-swap codes change when server transcription exists", () => {
    for (const code of CODES) {
      const same = micHelp(code) === micHelp(code, { cloudStt: true });
      expect(same).toBe(code !== "unsupported" && code !== "network");
    }
  });

  it("both permission codes tell the candidate exactly where to click", () => {
    for (const code of ["not-allowed", "service-not-allowed"]) {
      expect(micHelp(code)).toContain("address bar");
    }
    expect(micHelp("audio-capture")).not.toContain("address bar"); // a missing device is a different fix
  });

  const unknown: Array<{ label: string; reason: string | null }> = [
    { label: "no reason at all", reason: null },
    { label: "an empty reason", reason: "" },
    { label: "whitespace", reason: "   " },
    { label: "a code from a future engine", reason: "vosk_failed" },
    { label: "the wrong case", reason: "NETWORK" },
    { label: "an adapter code with no copy yet", reason: "start_failed" },
  ];

  it.each(unknown)("$label falls back to the retry-or-type copy", ({ reason }) => {
    expect(micHelp(reason)).toBe(micHelp(null));
    expect(micHelp(reason)).toContain("text mode");
  });
});
