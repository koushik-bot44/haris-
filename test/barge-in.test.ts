import { describe, expect, it } from "vitest";
import { BARGE_IN_WARMUP_MS, decideBargeIn, echoOverlap } from "@/lib/barge-in";

const PRIYA = "Tell me about a time you worked in a team and things did not go smoothly. What did you do?";

describe("barge-in decision", () => {
  it("ignores everything inside the warm-up window", () => {
    expect(
      decideBargeIn({ heardText: "wait I want to say something", spokenText: PRIYA, msSinceTtsStart: BARGE_IN_WARMUP_MS - 1 }),
    ).toBe("ignore");
  });

  it("ignores short noise fragments", () => {
    expect(decideBargeIn({ heardText: "uh so", spokenText: PRIYA, msSinceTtsStart: 2000 })).toBe("ignore");
  });

  it("ignores the interviewer's own voice echoing through the mic", () => {
    expect(
      decideBargeIn({
        heardText: "tell me about a time you worked in a team",
        spokenText: PRIYA,
        msSinceTtsStart: 2500,
      }),
    ).toBe("ignore");
  });

  it("interrupts on sustained, distinct candidate speech", () => {
    expect(
      decideBargeIn({
        heardText: "actually sorry can I answer the previous question differently",
        spokenText: PRIYA,
        msSinceTtsStart: 2500,
      }),
    ).toBe("interrupt");
  });

  it("echoOverlap is high for echoed text and low for genuine speech", () => {
    expect(echoOverlap("tell me about a time", PRIYA)).toBeGreaterThan(0.8);
    expect(echoOverlap("my internship at the startup last summer", PRIYA)).toBeLessThan(0.3);
  });

  it("empty heard text never interrupts", () => {
    expect(decideBargeIn({ heardText: "  ", spokenText: PRIYA, msSinceTtsStart: 5000 })).toBe("ignore");
  });

  it("ignores a brief distinct phrase — raised bar so speaker echo can't cut her off", () => {
    // Distinct from PRIYA (no echo), but too few words/chars to be a deliberate
    // interruption; under the no-headphones tuning this must NOT interrupt.
    expect(decideBargeIn({ heardText: "no wait stop", spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("ignore");
  });

  it("still respects the longer warm-up window", () => {
    expect(
      decideBargeIn({
        heardText: "actually sorry can I answer the previous question differently",
        spokenText: PRIYA,
        msSinceTtsStart: 1300,
      }),
    ).toBe("ignore");
  });
});
