import { describe, expect, it } from "vitest";
import { aggregateMetrics, computeDeliveryMetrics, countFillers } from "@/lib/metrics";
import type { SttTraceEvent } from "@/lib/types";

const r = (t: number, text: string, isFinal = true): SttTraceEvent => ({ kind: "result", t, text, isFinal });

describe("delivery metrics", () => {
  it("counts a >2s gap as a hesitation and tracks the longest pause", () => {
    const trace: SttTraceEvent[] = [
      { kind: "start", t: 0 },
      r(1000, "so my biggest strength"),
      r(4500, "is persistence"), // 3.5s gap → pause
      r(5500, "I never give up"),
      { kind: "stop", t: 6000 },
    ];
    const m = computeDeliveryMetrics(trace, "so my biggest strength is persistence I never give up");
    expect(m.hesitationCount).toBe(1);
    expect(m.longestPauseMs).toBe(3500);
  });

  it("excludes gaps that span a recognizer restart from pauses and WPM", () => {
    const trace: SttTraceEvent[] = [
      { kind: "start", t: 0 },
      r(1000, "first part of the answer here now"),
      { kind: "restart", t: 1200 }, // engine auto-stop
      r(8000, "second part continues"), // 7s gap — restart latency, NOT silence
      r(9000, "and ends"),
      { kind: "stop", t: 9500 },
    ];
    const m = computeDeliveryMetrics(trace, "first part of the answer here now second part continues and ends");
    expect(m.hesitationCount).toBe(0);
    expect(m.longestPauseMs).toBe(0);
  });

  it("returns wpm 0 below ~3s of usable signal instead of extrapolating noise", () => {
    const trace: SttTraceEvent[] = [
      { kind: "start", t: 0 },
      r(500, "yes"),
      r(1200, "definitely"),
      { kind: "stop", t: 1300 },
    ];
    const m = computeDeliveryMetrics(trace, "yes definitely");
    expect(m.wpm).toBe(0);
  });

  it("computes a plausible wpm over active speaking time", () => {
    // 30 words across 12s of continuous speech → 150 wpm
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const trace: SttTraceEvent[] = [{ kind: "start", t: 0 }];
    for (let i = 0; i <= 12; i++) trace.push(r(i * 1000, "chunk"));
    const m = computeDeliveryMetrics(trace, words);
    expect(m.wpm).toBe(150);
  });

  it("counts lexical fillers, not the ums Chrome never delivers", () => {
    expect(countFillers("Basically I was like actually working, you know, kind of hard")).toBe(5);
  });

  it("aggregates across answers with rounded values and max pause", () => {
    const agg = aggregateMetrics([
      { wpm: 140, fillerCount: 2, hesitationCount: 1, longestPauseMs: 2500 },
      { wpm: 160, fillerCount: 1, hesitationCount: 0, longestPauseMs: 0 },
      { wpm: 0, fillerCount: 0, hesitationCount: 0, longestPauseMs: 0 }, // too-short answer
    ]);
    expect(agg).toEqual({ wpm: 150, fillerCount: 3, hesitationCount: 1, longestPauseMs: 2500 });
  });

  it("returns null when no answer produced usable signal", () => {
    expect(aggregateMetrics([{ wpm: 0, fillerCount: 0, hesitationCount: 0, longestPauseMs: 0 }])).toBeNull();
  });
});
