import { describe, expect, it } from "vitest";
import { DEFAULT_VAD, initialVadState, vadStep, type VadEvent, type VadState } from "@/lib/vad";

function feed(samples: Array<[number, number]>): { state: VadState; events: VadEvent[] } {
  let state = initialVadState();
  const events: VadEvent[] = [];
  for (const [rms, t] of samples) {
    const out = vadStep(state, rms, t, DEFAULT_VAD);
    state = out.state;
    if (out.event) events.push(out.event);
  }
  return { state, events };
}

const LOUD = 0.05;
const QUIET = 0.001;

describe("VAD segmenter", () => {
  it("emits activity while speaking and cuts a segment after the silence gap", () => {
    const { events } = feed([
      [LOUD, 0],
      [LOUD, 300],
      [LOUD, 600],
      [QUIET, 700],
      [QUIET, 1500], // 900ms after last speech > 700ms cut
    ]);
    const seg = events.find((e) => e?.kind === "segment");
    expect(seg).toEqual({ kind: "segment", startT: 0, endT: 600 });
    expect(events.filter((e) => e?.kind === "activity").length).toBeGreaterThan(0);
  });

  it("drops sub-300ms noise blips instead of transcribing them", () => {
    const { events } = feed([
      [LOUD, 0],
      [LOUD, 100], // 100ms blip
      [QUIET, 200],
      [QUIET, 1000],
    ]);
    expect(events.find((e) => e?.kind === "segment")).toBeUndefined();
  });

  it("hysteresis: mid-level audio keeps a running segment alive but never starts one", () => {
    const MID = 0.01; // between exitRms (0.008) and enterRms (0.015)
    const idle = feed([[MID, 0], [MID, 500]]);
    expect(idle.events.length).toBe(0);

    const running = feed([
      [LOUD, 0],
      [MID, 300], // still counts as speech continuing
      [QUIET, 600],
      [QUIET, 1400],
    ]);
    const seg = running.events.find((e) => e?.kind === "segment");
    expect(seg).toEqual({ kind: "segment", startT: 0, endT: 300 });
  });

  it("force-cuts marathon segments and continues seamlessly", () => {
    const samples: Array<[number, number]> = [];
    for (let t = 0; t <= 11_000; t += 500) samples.push([LOUD, t]);
    const { events, state } = feed(samples);
    const segs = events.filter((e) => e?.kind === "segment");
    expect(segs.length).toBe(1); // one forced cut at ~10s
    expect(state.segmentStartT).not.toBeNull(); // next segment already running
  });
});
