import { describe, expect, it } from "vitest";
import {
  acceptSpeculation,
  countWords,
  decideListenAction,
  GIVE_UP_MS,
  NUDGE_START_MS,
  OFFER_REPHRASE_MS,
  PAUSE_END_MS,
  shouldSpeculate,
  SPECULATE_MIN_WORDS,
  SPECULATE_PAUSE_MS,
  SPECULATE_REARM_WORDS,
  SPECULATION_STALE_WORDS,
  THIN_ANSWER_WORDS,
  type ListenAction,
  type ListenSnapshot,
} from "@/lib/conversation";
import { clampHistoryText, HISTORY_ENTRY_MAX_CHARS, keepTail, stripAckEcho } from "@/lib/speakable";

function snap(partial: Partial<ListenSnapshot>): ListenSnapshot {
  return { msSinceListenStart: 0, msSinceLastSpeech: null, words: 0, nudges: 0, ...partial };
}

describe("silent path (no speech yet)", () => {
  it("waits before the first nudge threshold", () => {
    expect(decideListenAction(snap({ msSinceListenStart: 0 }))).toBe("wait");
    expect(decideListenAction(snap({ msSinceListenStart: NUDGE_START_MS - 1 }))).toBe("wait");
  });

  it("nudges to start exactly at 7000ms, once", () => {
    expect(decideListenAction(snap({ msSinceListenStart: NUDGE_START_MS }))).toBe("nudge_start");
    // Already nudged → hold until the rephrase stage.
    expect(decideListenAction(snap({ msSinceListenStart: NUDGE_START_MS, nudges: 1 }))).toBe("wait");
    expect(decideListenAction(snap({ msSinceListenStart: OFFER_REPHRASE_MS - 1, nudges: 1 }))).toBe("wait");
  });

  it("offers a rephrase exactly at 16000ms, once", () => {
    expect(decideListenAction(snap({ msSinceListenStart: OFFER_REPHRASE_MS, nudges: 1 }))).toBe("offer_rephrase");
    expect(decideListenAction(snap({ msSinceListenStart: OFFER_REPHRASE_MS, nudges: 2 }))).toBe("wait");
    expect(decideListenAction(snap({ msSinceListenStart: GIVE_UP_MS - 1, nudges: 2 }))).toBe("wait");
  });

  it("gives up exactly at 28000ms regardless of nudge count", () => {
    expect(decideListenAction(snap({ msSinceListenStart: GIVE_UP_MS, nudges: 2 }))).toBe("give_up");
    expect(decideListenAction(snap({ msSinceListenStart: GIVE_UP_MS, nudges: 0 }))).toBe("give_up");
    expect(decideListenAction(snap({ msSinceListenStart: GIVE_UP_MS + 60000, nudges: 2 }))).toBe("give_up");
  });

  it("a stalled timer escalates through stages in order, never double-fires", () => {
    // Tab throttling can jump the clock past 16s with no nudge delivered yet:
    // stage 1 still fires first (count-keyed), then stage 2 on the next tick.
    expect(decideListenAction(snap({ msSinceListenStart: OFFER_REPHRASE_MS + 500, nudges: 0 }))).toBe("nudge_start");
    expect(decideListenAction(snap({ msSinceListenStart: OFFER_REPHRASE_MS + 750, nudges: 1 }))).toBe("offer_rephrase");
    expect(decideListenAction(snap({ msSinceListenStart: OFFER_REPHRASE_MS + 1000, nudges: 2 }))).toBe("wait");
  });

  it("simulated 250ms ticks fire each stage exactly once", () => {
    const fired: ListenAction[] = [];
    let nudges = 0;
    for (let t = 0; t <= GIVE_UP_MS; t += 250) {
      const a = decideListenAction(snap({ msSinceListenStart: t, nudges }));
      if (a === "wait") continue;
      fired.push(a);
      if (a === "give_up") break;
      nudges += 1;
    }
    expect(fired).toEqual(["nudge_start", "offer_rephrase", "give_up"]);
  });
});

describe("pause path (speech present)", () => {
  it("waits below the pause boundary — 1499ms", () => {
    expect(decideListenAction(snap({ msSinceLastSpeech: PAUSE_END_MS - 1, words: 40 }))).toBe("wait");
    expect(decideListenAction(snap({ msSinceLastSpeech: 0, words: 2 }))).toBe("wait");
  });

  it("ends a substantial answer exactly at 1500ms", () => {
    expect(decideListenAction(snap({ msSinceLastSpeech: PAUSE_END_MS, words: THIN_ANSWER_WORDS }))).toBe("end_answer");
    expect(decideListenAction(snap({ msSinceLastSpeech: PAUSE_END_MS, words: 200 }))).toBe("end_answer");
  });

  it("nudges a thin answer (14 words) once, then ends", () => {
    expect(decideListenAction(snap({ msSinceLastSpeech: PAUSE_END_MS, words: THIN_ANSWER_WORDS - 1 }))).toBe(
      "nudge_continue",
    );
    // Nudge spent — the next qualifying pause ends the answer even if thin.
    expect(
      decideListenAction(snap({ msSinceLastSpeech: PAUSE_END_MS, words: THIN_ANSWER_WORDS - 1, nudges: 1 })),
    ).toBe("end_answer");
  });

  it("15 words at the boundary ends without a nudge", () => {
    expect(decideListenAction(snap({ msSinceLastSpeech: PAUSE_END_MS, words: 15, nudges: 0 }))).toBe("end_answer");
  });

  it("VAD-only speech (energy heard, no words yet) gets the continue nudge", () => {
    expect(decideListenAction(snap({ msSinceLastSpeech: PAUSE_END_MS, words: 0 }))).toBe("nudge_continue");
  });

  it("nudge exhaustion ordering: a silent-path nudge also spends the continue nudge", () => {
    // nudge_start fired pre-speech (nudges=1); the candidate then gave a thin
    // answer — one nudge per answer total, so the pause ends it.
    expect(
      decideListenAction(snap({ msSinceLastSpeech: PAUSE_END_MS, words: 8, nudges: 1 })),
    ).toBe("end_answer");
    expect(
      decideListenAction(snap({ msSinceLastSpeech: PAUSE_END_MS, words: 8, nudges: 2 })),
    ).toBe("end_answer");
  });

  it("speech present ignores the silent-path clock entirely", () => {
    // Long into the answer, the pause rules own the decision — never give_up.
    expect(
      decideListenAction(snap({ msSinceListenStart: GIVE_UP_MS + 5000, msSinceLastSpeech: 100, words: 50 })),
    ).toBe("wait");
    expect(
      decideListenAction(
        snap({ msSinceListenStart: GIVE_UP_MS + 5000, msSinceLastSpeech: PAUSE_END_MS, words: 50 }),
      ),
    ).toBe("end_answer");
  });

  it("thin-answer nudge then continued speech ends normally on the next pause", () => {
    // After nudge_continue the candidate kept talking to 20 words.
    expect(decideListenAction(snap({ msSinceLastSpeech: 300, words: 20, nudges: 1 }))).toBe("wait");
    expect(decideListenAction(snap({ msSinceLastSpeech: PAUSE_END_MS, words: 20, nudges: 1 }))).toBe("end_answer");
  });
});

describe("shouldSpeculate (draft-point policy)", () => {
  it("fires at exactly an 800ms pause with enough words", () => {
    expect(
      shouldSpeculate(snap({ msSinceLastSpeech: SPECULATE_PAUSE_MS, words: SPECULATE_MIN_WORDS }), null),
    ).toBe(true);
  });

  it("waits below the pause boundary (799ms)", () => {
    expect(shouldSpeculate(snap({ msSinceLastSpeech: SPECULATE_PAUSE_MS - 1, words: 40 }), null)).toBe(false);
  });

  it("never fires before any speech (msSinceLastSpeech null)", () => {
    expect(shouldSpeculate(snap({ msSinceListenStart: 10000, msSinceLastSpeech: null, words: 0 }), null)).toBe(
      false,
    );
  });

  it("requires at least 15 words (14 is too thin to guess on)", () => {
    expect(
      shouldSpeculate(snap({ msSinceLastSpeech: 2000, words: SPECULATE_MIN_WORDS - 1 }), null),
    ).toBe(false);
  });

  it("re-arms only after the transcript grows by ≥25 words past the basis", () => {
    expect(shouldSpeculate(snap({ msSinceLastSpeech: 900, words: 20 }), 20)).toBe(false); // +0
    expect(shouldSpeculate(snap({ msSinceLastSpeech: 900, words: 20 + SPECULATE_REARM_WORDS - 1 }), 20)).toBe(
      false, // +24 — cached speculation stands
    );
    expect(shouldSpeculate(snap({ msSinceLastSpeech: 900, words: 20 + SPECULATE_REARM_WORDS }), 20)).toBe(
      true, // +25 — replace with a fresher guess
    );
  });

  it("the draft point sits INSIDE the answer: listen policy still says wait", () => {
    // 800–1499ms of pause: speculation is in flight while the answer is still
    // open — that head start is the whole latency win.
    const s = snap({ msSinceLastSpeech: SPECULATE_PAUSE_MS, words: 30 });
    expect(decideListenAction(s)).toBe("wait");
    expect(shouldSpeculate(s, null)).toBe(true);
    expect(SPECULATE_PAUSE_MS).toBeLessThan(PAUSE_END_MS);
  });
});

describe("acceptSpeculation (endAnswer acceptance rule)", () => {
  it("accepts when growth stays under 8 words (7 = boundary accept)", () => {
    expect(acceptSpeculation(20, 20)).toBe(true);
    expect(acceptSpeculation(20, 20 + SPECULATION_STALE_WORDS - 1)).toBe(true); // +7
  });

  it("rejects at exactly 8 added words and beyond", () => {
    expect(acceptSpeculation(20, 20 + SPECULATION_STALE_WORDS)).toBe(false); // +8
    expect(acceptSpeculation(20, 60)).toBe(false);
  });

  it("negative growth (settle shrank interim text) accepts", () => {
    expect(acceptSpeculation(20, 15)).toBe(true);
    expect(acceptSpeculation(20, 0)).toBe(true);
  });
});

describe("countWords", () => {
  it("handles empty, whitespace, and multi-space input", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("one")).toBe(1);
    expect(countWords("one  two\n three")).toBe(3);
  });
});

// ——— transcript hygiene helpers the interview hook applies (lib/speakable) ———

// Mirrors lib/ack.ts ACK_TEXTS — importing ack.ts would drag browser-only TTS
// modules into the node test environment.
const ACK_LINES = [
  "Hmm.",
  "Mm-hm, okay.",
  "Right.",
  "Mm-hm — go on?",
  "Take your time.",
  "No rush. Want me to rephrase the question?",
];

describe("stripAckEcho (speaker-echoed nudges scrubbed off transcript edges)", () => {
  it("strips an exact ack line at the start", () => {
    expect(stripAckEcho("Mm-hm — go on? I optimized the query with an index.", ACK_LINES)).toBe(
      "I optimized the query with an index.",
    );
  });

  it("strips case/punctuation/spacing variants at the edge", () => {
    expect(stripAckEcho("mm hm go on I used a HashMap there", ACK_LINES)).toBe("I used a HashMap there");
    expect(stripAckEcho("take your time... So my project used Spring Boot", ACK_LINES)).toBe(
      "So my project used Spring Boot",
    );
  });

  it("strips an echoed line at the END of the transcript", () => {
    expect(
      stripAckEcho("I would use a queue here. No rush want me to rephrase the question", ACK_LINES),
    ).toBe("I would use a queue here.");
  });

  it("does NOT strip a legit 'go on' mid-sentence", () => {
    const t = "I decided to go on with the migration anyway";
    expect(stripAckEcho(t, ACK_LINES)).toBe(t);
  });

  it("peels stacked echoes; a pure-echo transcript becomes empty", () => {
    expect(stripAckEcho("Hmm. Mm-hm, okay.", ACK_LINES)).toBe("");
  });

  it("leaves a clean answer untouched", () => {
    const t = "My final year project is a placement day simulator.";
    expect(stripAckEcho(t, ACK_LINES)).toBe(t);
  });
});

describe("clampHistoryText (/api/interview per-entry cap)", () => {
  it("returns short and boundary-length text unchanged", () => {
    expect(clampHistoryText("short answer")).toBe("short answer");
    const exact = "y".repeat(HISTORY_ENTRY_MAX_CHARS);
    expect(clampHistoryText(exact)).toBe(exact);
  });

  it("tail-truncates an over-long entry to the cap with a marker", () => {
    const out = clampHistoryText("x".repeat(HISTORY_ENTRY_MAX_CHARS + 500));
    expect(out.length).toBe(HISTORY_ENTRY_MAX_CHARS); // schema-valid forever after
    expect(out.endsWith("…[truncated]")).toBe(true);
    expect(out.startsWith("xxx")).toBe(true); // head kept, tail cut
  });
});

describe("keepTail (/api/score sends the newest content of a combined answer)", () => {
  it("returns short text unchanged", () => {
    expect(keepTail("brief", 8000)).toBe("brief");
  });

  it("keeps exactly the last max chars — newest content wins", () => {
    const s = "a".repeat(50) + "NEWEST";
    const out = keepTail(s, 10);
    expect(out.length).toBe(10);
    expect(out).toBe(s.slice(-10));
    expect(out.endsWith("NEWEST")).toBe(true);
  });
});
