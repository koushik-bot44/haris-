import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fullTranscript,
  initialSttState,
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
