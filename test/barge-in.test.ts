import { describe, expect, it } from "vitest";
import {
  BARGE_IN_WARMUP_MS,
  decideBargeIn,
  dropSelfEcho,
  echoOverlap,
  ECHO_RUN_TOKENS,
  longestSharedRun,
  novelWordCount,
} from "@/lib/barge-in";

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

// The mic is live by DEFAULT now, so these run for every candidate — most of
// them on laptop speakers. Two failure modes matter more than they used to:
// her voice leaking back in, and the candidate's own "yeah… okay…" while they
// listen. Neither may take the floor.

describe("barge-in with the mic live by default", () => {
  it("rejects a verbatim run of her words even when the ratio is diluted", () => {
    // Only 4 of 16 heard words are hers, so token-SET overlap says 0.25 —
    // under the echo threshold. But those four arrived back-to-back, in her
    // order: that is a recording of her, not a coincidence.
    const heard =
      "worked in a team and my supervisor asked whether the deployment pipeline could handle rollback across regions";
    expect(echoOverlap(heard, PRIYA)).toBeLessThan(0.34);
    expect(longestSharedRun(heard, PRIYA)).toBeGreaterThanOrEqual(ECHO_RUN_TOKENS);
    expect(decideBargeIn({ heardText: heard, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("ignore");
  });

  it("a candidate quoting a SHORT phrase of the question still takes the floor", () => {
    // Three of her words in a row — the natural way anyone starts answering
    // this question. The run bar sits at four precisely so this survives.
    const heard = "worked in a team on my final year project with two friends";
    expect(longestSharedRun(heard, PRIYA)).toBeLessThan(ECHO_RUN_TOKENS);
    expect(decideBargeIn({ heardText: heard, spokenText: PRIYA, msSinceTtsStart: 3000 })).toBe("interrupt");
  });

  it("backchannel is listening, not interrupting", () => {
    // Long enough and wordy enough to clear the substance bar, no overlap with
    // her line at all — and still not an interruption: not one word of it is
    // the candidate's own content.
    const heard = "yeah yeah okay right mm-hm okay sure yeah";
    expect(heard.length).toBeGreaterThan(28);
    expect(echoOverlap(heard, PRIYA)).toBe(0);
    expect(novelWordCount(heard, PRIYA)).toBe(0);
    expect(decideBargeIn({ heardText: heard, spokenText: PRIYA, msSinceTtsStart: 4000 })).toBe("ignore");
  });

  it("a short, unmistakable interruption gets through", () => {
    expect(
      decideBargeIn({ heardText: "sorry could you repeat that", spokenText: PRIYA, msSinceTtsStart: 2000 }),
    ).toBe("interrupt");
  });

  it("her own ack lines are part of the echo reference, not an interruption", () => {
    const spoken = `${PRIYA} Mm-hm — go on? Take your time. No rush. Want me to rephrase the question?`;
    expect(
      decideBargeIn({
        heardText: "no rush want me to rephrase the question take your time",
        spokenText: spoken,
        msSinceTtsStart: 3000,
      }),
    ).toBe("ignore");
  });
});

describe("dropSelfEcho (her question must never be filed as their answer)", () => {
  const HER = "Tell me about a time you worked in a team";
  const THEM = "so my final year project was a placement day simulator";

  it("drops echoed segments inside the window, keeps the candidate's", () => {
    expect(dropSelfEcho([HER, THEM], PRIYA, 2)).toEqual([THEM]);
    expect(dropSelfEcho([HER, THEM], PRIYA, 1)).toEqual([THEM]);
  });

  it("touches nothing once the window is closed — a repeated question is theirs", () => {
    // Heavy overlap with her line, but heard AFTER the mic became theirs: the
    // candidate is restating the question while answering it, and every word
    // of that belongs to them.
    const restated = "things did not go smoothly at first";
    expect(echoOverlap(restated, PRIYA)).toBeGreaterThan(0.34); // would be dropped inside the window
    expect(dropSelfEcho([restated], PRIYA, 0)).toEqual([restated]);
    expect(dropSelfEcho([restated], PRIYA, 1)).toEqual([]);
  });

  it("an empty window leaves an ordinary answer untouched", () => {
    expect(dropSelfEcho([THEM], PRIYA, 5)).toEqual([THEM]);
  });
});
