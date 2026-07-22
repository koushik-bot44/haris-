import { describe, expect, it } from "vitest";
import {
  AIRTIME_BAND,
  airtimeFromTurns,
  airtimeScore,
  buildOverlap,
  composeGdVerdict,
  INTERJECTION_WINDOW_MS,
} from "@/lib/gd/airtime";
import type { GdMetrics, Turn } from "@/lib/types";

const T0 = 1_000_000; // discussion start

function personaTurn(personaId: string, text: string, tStart: number, tEnd: number): Turn {
  return { speaker: "interviewer", text, tStart, tEnd, personaId, personaName: personaId };
}

function candidateTurn(text: string, tStart: number, tEnd: number): Turn {
  return { speaker: "candidate", text, tStart, tEnd };
}

describe("airtimeFromTurns", () => {
  it("sums per-speaker airtime and computes the candidate share", () => {
    const turns: Turn[] = [
      personaTurn("dominator", "jobs are fine", T0, T0 + 4000),
      candidateTurn("my point", T0 + 6000, T0 + 7000),
      personaTurn("data", "numbers say so", T0 + 7500, T0 + 12500),
    ];
    const m = airtimeFromTurns(turns, T0);
    expect(m.candidateAirtimeMs).toBe(1000);
    expect(m.personaAirtimeMs).toEqual({ dominator: 4000, data: 5000 });
    expect(m.airtimeSharePct).toBe(10);
    expect(m.candidateTurns).toBe(1);
  });

  it("rounds the share to one decimal", () => {
    const turns: Turn[] = [
      personaTurn("data", "x", T0, T0 + 2000),
      candidateTurn("y", T0 + 5000, T0 + 6000),
    ];
    expect(airtimeFromTurns(turns, T0).airtimeSharePct).toBe(33.3);
  });

  it("counts a candidate turn starting mid-persona-turn as an interjection", () => {
    const turns: Turn[] = [
      personaTurn("dominator", "automation destroys testing jobs", T0, T0 + 5000),
      candidateTurn("I disagree that testing jobs vanish", T0 + 3000, T0 + 6000),
    ];
    const m = airtimeFromTurns(turns, T0);
    expect(m.interjections).toHaveLength(1);
    expect(m.interjections[0].tMs).toBe(3000);
  });

  it("counts a candidate turn within the window after a persona turn ends", () => {
    const turns: Turn[] = [
      personaTurn("data", "some claim", T0, T0 + 5000),
      candidateTurn("quick reply", T0 + 5000 + INTERJECTION_WINDOW_MS, T0 + 8000),
    ];
    expect(airtimeFromTurns(turns, T0).interjections).toHaveLength(1);
  });

  it("does not count a turn well after the persona finished", () => {
    const turns: Turn[] = [
      personaTurn("data", "some claim", T0, T0 + 5000),
      candidateTurn("slow reply", T0 + 5000 + INTERJECTION_WINDOW_MS + 1200, T0 + 9000),
    ];
    const m = airtimeFromTurns(turns, T0);
    expect(m.interjections).toHaveLength(0);
    expect(m.candidateTurns).toBe(1); // still airtime, just not an interjection
  });

  it("marks builtOnPrevious via token overlap with the previous persona turn", () => {
    const turns: Turn[] = [
      personaTurn("dominator", "AI will destroy manual testing jobs in five years", T0, T0 + 5000),
      candidateTurn("I disagree that testing jobs will vanish, automation creates testing demand", T0 + 4000, T0 + 8000),
    ];
    expect(airtimeFromTurns(turns, T0).interjections[0].builtOnPrevious).toBe(true);
  });

  it("marks a subject change as not built on the previous point", () => {
    const turns: Turn[] = [
      personaTurn("dominator", "AI will destroy manual testing jobs in five years", T0, T0 + 5000),
      candidateTurn("completely unrelated point regarding cricket strategy", T0 + 4000, T0 + 8000),
    ];
    expect(airtimeFromTurns(turns, T0).interjections[0].builtOnPrevious).toBe(false);
  });

  it("returns clean zeros for an empty discussion", () => {
    const m = airtimeFromTurns([], T0);
    expect(m.airtimeSharePct).toBe(0);
    expect(m.candidateTurns).toBe(0);
    expect(m.candidateAirtimeMs).toBe(0);
    expect(m.interjections).toEqual([]);
  });

  it("share is 0 when the candidate never spoke", () => {
    const m = airtimeFromTurns([personaTurn("fence", "hmm", T0, T0 + 3000)], T0);
    expect(m.airtimeSharePct).toBe(0);
    expect(m.candidateTurns).toBe(0);
  });
});

describe("buildOverlap", () => {
  it("is the fraction of candidate tokens present in the persona text", () => {
    expect(buildOverlap("testing jobs matter", "testing jobs are gone")).toBeCloseTo(2 / 3);
    expect(buildOverlap("", "anything")).toBe(0);
  });
});

function metrics(over: Partial<GdMetrics>): GdMetrics {
  return {
    airtimeSharePct: 25,
    interjections: [],
    candidateTurns: 2,
    candidateAirtimeMs: 60_000,
    personaAirtimeMs: { dominator: 90_000, data: 60_000, fence: 30_000 },
    ...over,
  };
}

describe("composeGdVerdict", () => {
  it("flags total silence warmly with a null score", () => {
    const v = composeGdVerdict(metrics({ candidateTurns: 0, airtimeSharePct: 0, candidateAirtimeMs: 0 }));
    expect(v.avgScore).toBeNull();
    expect(v.summary).toContain("SPACE");
    expect(v.summary.toLowerCase()).not.toContain("fail");
  });

  it("scores the ideal band with building interjections at the top", () => {
    const v = composeGdVerdict(
      metrics({ airtimeSharePct: 28, interjections: [{ tMs: 10_000, builtOnPrevious: true }] }),
    );
    expect(v.avgScore).toBe(5);
    expect(v.summary).toContain("28% of the airtime");
  });

  it("tells a dominator to create space", () => {
    const v = composeGdVerdict(
      metrics({
        airtimeSharePct: 75,
        interjections: [
          { tMs: 5_000, builtOnPrevious: false },
          { tMs: 40_000, builtOnPrevious: false },
        ],
      }),
    );
    expect(v.avgScore).not.toBeNull();
    expect(v.avgScore as number).toBeLessThan(4);
    expect(v.summary.toLowerCase()).toContain("space");
  });

  it("tells a quiet candidate to push toward the band", () => {
    const v = composeGdVerdict(metrics({ airtimeSharePct: 8 }));
    expect(v.summary).toContain(`${AIRTIME_BAND[0]}–${AIRTIME_BAND[1]}%`);
    expect(v.summary).toContain("8% of the airtime");
  });

  it("rewards interjections that build over interjections that derail", () => {
    const built = composeGdVerdict(
      metrics({
        interjections: [
          { tMs: 1000, builtOnPrevious: true },
          { tMs: 2000, builtOnPrevious: true },
          { tMs: 3000, builtOnPrevious: true },
        ],
      }),
    );
    const derailed = composeGdVerdict(
      metrics({
        interjections: [
          { tMs: 1000, builtOnPrevious: false },
          { tMs: 2000, builtOnPrevious: false },
          { tMs: 3000, builtOnPrevious: false },
        ],
      }),
    );
    expect(built.avgScore as number).toBeGreaterThan(derailed.avgScore as number);
    expect(derailed.summary).toContain("changed the subject");
  });

  it("is deterministic", () => {
    const m = metrics({ airtimeSharePct: 31 });
    expect(composeGdVerdict(m)).toEqual(composeGdVerdict(m));
  });

  describe("micTrouble", () => {
    const dead = metrics({ candidateTurns: 0, airtimeSharePct: 0, candidateAirtimeMs: 0 });

    it("a dead mic with zero captured airtime is honestly unscored, not coached for silence", () => {
      const v = composeGdVerdict(dead, { micTrouble: true });
      expect(v.avgScore).toBeNull();
      expect(v.summary.toLowerCase()).toContain("microphone");
      expect(v.summary).toContain("isn't scored");
      // NOT the take-the-floor coaching — that verdict blames the candidate.
      expect(v.summary).not.toContain("SPACE");
    });

    it("without the flag, a silent round still gets the take-the-floor coaching", () => {
      const v = composeGdVerdict(dead);
      expect(v.avgScore).toBeNull();
      expect(v.summary).toContain("SPACE");
    });

    it("mic trouble after real captured airtime scores normally", () => {
      const m = metrics({ airtimeSharePct: 28 });
      expect(composeGdVerdict(m, { micTrouble: true })).toEqual(composeGdVerdict(m));
    });

    it("mic trouble with zero airtime beats the silence branch even when turns were counted", () => {
      // Degenerate but possible: a floor turn recorded with tStart === tEnd.
      const m = metrics({ candidateTurns: 1, airtimeSharePct: 0, candidateAirtimeMs: 0 });
      const v = composeGdVerdict(m, { micTrouble: true });
      expect(v.avgScore).toBeNull();
      expect(v.summary).toContain("isn't scored");
    });
  });
});

describe("airtimeScore", () => {
  it("is 5 across the band and falls off outside it", () => {
    expect(airtimeScore(20)).toBe(5);
    expect(airtimeScore(35)).toBe(5);
    expect(airtimeScore(0)).toBe(1);
    expect(airtimeScore(10)).toBe(3);
    expect(airtimeScore(60)).toBe(3);
    expect(airtimeScore(100)).toBeLessThanOrEqual(1.001);
  });
});
