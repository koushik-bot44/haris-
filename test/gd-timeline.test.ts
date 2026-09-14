import { describe, expect, it } from "vitest";
import {
  airtimeFromTurns,
  candidateFinals,
  candidateTurnStart,
  markInterrupt,
  MAX_EARLY_START_MS,
  MIN_RATE_SAMPLE_MS,
  NOMINAL_SPEECH_CHARS_PER_MS,
  speechRateCharsPerMs,
  spokenPrefix,
  type InterruptMark,
} from "@/lib/gd/airtime";
import { dropSelfEcho } from "@/lib/barge-in";
import type { SttTraceEvent, Turn } from "@/lib/types";

// The GD room's "honest timeline" suite.
//
// Everything the report says about a discussion is derived from recorded turns,
// so a lie in the recording is a lie in the mark. Three confirmed lies are
// pinned here:
//   1. a persona cancelled mid-word recorded as having said its whole line;
//   2. the candidate's turn backdated to the persona's echo in the live mic;
//   3. the silence watchdog and the transcript builder disagreeing about which
//      final segments belong to the candidate's floor.

const PERSONA_LINE = "AI will destroy manual testing jobs within five years, and everyone knows it.";

describe("spokenPrefix — a cut-off line is recorded as what was heard", () => {
  it("returns the whole line when the voice was never cut short", () => {
    const ms = PERSONA_LINE.length / NOMINAL_SPEECH_CHARS_PER_MS;
    expect(spokenPrefix(PERSONA_LINE, ms)).toBe(PERSONA_LINE);
    expect(spokenPrefix(PERSONA_LINE, ms * 10)).toBe(PERSONA_LINE);
  });

  it("cuts on a word boundary and marks the interruption", () => {
    // ~2s of speech at the nominal rate ≈ 31 characters.
    const said = spokenPrefix(PERSONA_LINE, 2000);
    expect(said.endsWith("—")).toBe(true);
    expect(said.length).toBeLessThan(PERSONA_LINE.length);
    // Whatever it kept must be a genuine prefix of the line — never a paraphrase
    // and never half a word.
    const words = said.slice(0, -1);
    expect(PERSONA_LINE.startsWith(words)).toBe(true);
    expect(words.endsWith(" ")).toBe(false);
  });

  it("never records words the room never heard", () => {
    const said = spokenPrefix(PERSONA_LINE, 2000).replace(/—$/, "");
    expect(said).not.toContain("everyone knows it");
    expect(said.length).toBeLessThan(PERSONA_LINE.length / 2);
  });

  it("strips the punctuation the cut landed on before the dash", () => {
    // "Let me be blunt, the answer is obvious." cut after "blunt,"
    const text = "Let me be blunt, the answer is obvious.";
    const said = spokenPrefix(text, 1100); // ≈17 chars — lands just past the comma
    expect(said).toBe("Let me be blunt—");
  });

  it("returns nothing when the cancel landed inside the first word", () => {
    expect(spokenPrefix(PERSONA_LINE, 60)).toBe("");
    expect(spokenPrefix("Absolutely", 200)).toBe("");
  });

  it("returns nothing for a turn whose audio never started", () => {
    expect(spokenPrefix(PERSONA_LINE, 0)).toBe("");
    expect(spokenPrefix(PERSONA_LINE, -500)).toBe("");
    expect(spokenPrefix("   ", 5000)).toBe("");
  });

  it("honours a measured rate: a slower voice says less in the same time", () => {
    const slow = spokenPrefix(PERSONA_LINE, 3000, 0.008);
    const fast = spokenPrefix(PERSONA_LINE, 3000, 0.03);
    expect(slow.length).toBeLessThan(fast.length);
    expect(PERSONA_LINE.startsWith(slow.replace(/—$/, ""))).toBe(true);
  });

  it("falls back to the nominal rate on a nonsense rate", () => {
    expect(spokenPrefix(PERSONA_LINE, 2000, 0)).toBe(spokenPrefix(PERSONA_LINE, 2000));
    expect(spokenPrefix(PERSONA_LINE, 2000, Number.NaN)).toBe(spokenPrefix(PERSONA_LINE, 2000));
  });
});

describe("speechRateCharsPerMs — the room measures its own voice", () => {
  it("is nominal until there is enough of a sample", () => {
    expect(speechRateCharsPerMs(0, 0)).toBe(NOMINAL_SPEECH_CHARS_PER_MS);
    expect(speechRateCharsPerMs(40, MIN_RATE_SAMPLE_MS - 1)).toBe(NOMINAL_SPEECH_CHARS_PER_MS);
    expect(speechRateCharsPerMs(-5, 10_000)).toBe(NOMINAL_SPEECH_CHARS_PER_MS);
    expect(speechRateCharsPerMs(Number.NaN, 10_000)).toBe(NOMINAL_SPEECH_CHARS_PER_MS);
  });

  it("reports the observed rate once a real turn has been spoken", () => {
    expect(speechRateCharsPerMs(150, 10_000)).toBeCloseTo(0.015, 5);
  });

  it("clamps a nonsense measurement instead of cutting at word one (or never)", () => {
    expect(speechRateCharsPerMs(5, 100_000)).toBeGreaterThan(0.005);
    expect(speechRateCharsPerMs(100_000, 3000)).toBeLessThan(0.04);
  });
});

describe("candidateFinals — one definition of the candidate's floor speech", () => {
  const adopted = { finals: 2, echoRef: PERSONA_LINE };

  it("keeps everything when the floor was grabbed in a gap (no echo reference)", () => {
    expect(candidateFinals(["one", "two"], null)).toEqual(["one", "two"]);
  });

  it("drops pre-adoption segments that are the persona through the speakers", () => {
    const finals = ["AI will destroy manual testing", "jobs within five years", "post adoption words here"];
    expect(candidateFinals(finals, adopted)).toEqual(["post adoption words here"]);
  });

  it("KEEPS pre-adoption segments that are genuinely the candidate — the early start", () => {
    // The 5-second dead stall: an early start's words are already final at the
    // moment the floor is adopted, so a post-adoption-only rule saw an empty
    // floor and waited out GD_EMPTY_FLOOR_MS while the transcript already had
    // the sentence.
    const finals = ["AI will destroy manual testing", "sorry but that assumes nothing else changes"];
    const early = { finals: finals.length, echoRef: PERSONA_LINE };
    expect(candidateFinals(finals, early)).toEqual(["sorry but that assumes nothing else changes"]);
    expect(candidateFinals(finals, early).length > 0).toBe(true); // watchdog sees speech
  });

  it("never drops anything heard after the floor was taken", () => {
    // Index 2 is post-adoption and echoes the persona word for word — that is
    // the candidate quoting them back, and it is their floor. Only the two
    // pre-adoption echoes go.
    const finals = ["AI will destroy manual testing", "jobs within five years", "AI will destroy manual testing jobs"];
    expect(candidateFinals(finals, adopted)).toEqual(["AI will destroy manual testing jobs"]);
  });

  it("IS the 1:1 room's dropSelfEcho — the two rooms cannot drift apart", () => {
    // Mixed bag: pure echo, near-echo, candidate words, and a post-adoption
    // verbatim quote. Whatever barge-in.ts decides, the GD floor decides too.
    const finals = [
      "AI will destroy manual testing jobs",
      "within five years everyone knows",
      "sorry but that assumes nothing else changes",
      "AI will destroy manual testing jobs",
      "and that is my point",
    ];
    for (const upto of [0, 1, 2, 3, 4, 5, 9]) {
      expect(candidateFinals(finals, { finals: upto, echoRef: PERSONA_LINE })).toEqual(
        dropSelfEcho(finals, PERSONA_LINE, upto),
      );
    }
  });
});

describe("markInterrupt — only a cut voice gets an em dash", () => {
  const fresh = (): InterruptMark => ({ promoted: false, cutOff: false });

  it("an interruption while the audio is playing promotes AND cuts", () => {
    const m = fresh();
    markInterrupt(m, false);
    expect(m).toEqual({ promoted: true, cutOff: true });
  });

  it("a floor grab after the last syllable promotes WITHOUT cutting", () => {
    // The SPACE-between-done-and-bookkeeping window: the persona said its
    // whole line; the candidate merely spoke next. Recording "…line—" here
    // was the spurious dash.
    const m = fresh();
    markInterrupt(m, true);
    expect(m).toEqual({ promoted: true, cutOff: false });
  });

  it("the first interruption decides; a late repeat can neither cut nor un-cut", () => {
    const cut = fresh();
    markInterrupt(cut, false);
    markInterrupt(cut, true);
    expect(cut.cutOff).toBe(true);

    const whole = fresh();
    markInterrupt(whole, true);
    markInterrupt(whole, false);
    expect(whole.cutOff).toBe(false);
  });
});

describe("candidateTurnStart — the turn starts at the candidate's first word", () => {
  const FLOOR_T = 100_000;
  const adopted = { finals: 1, echoRef: PERSONA_LINE };

  function result(t: number, text: string, isFinal = false): SttTraceEvent {
    return { kind: "result", t, text, isFinal };
  }

  it("ignores the persona's own voice in the mic and finds the real first word", () => {
    const trace: SttTraceEvent[] = [
      { kind: "start", t: FLOOR_T - 9000 },
      result(FLOOR_T - 8000, "AI will destroy manual testing jobs"),
      result(FLOOR_T - 2500, "sorry, that assumes nothing else changes"),
      result(FLOOR_T + 400, "sorry, that assumes nothing else changes at all", true),
    ];
    expect(candidateTurnStart(trace, FLOOR_T, adopted)).toBe(FLOOR_T - 2500);
  });

  it("regression: does NOT backdate the turn to the first trace event", () => {
    const trace: SttTraceEvent[] = [
      { kind: "start", t: FLOOR_T - 30_000 },
      result(FLOOR_T - 29_000, "AI will destroy manual testing jobs within five years"),
      result(FLOOR_T + 200, "I want to come in on that", true),
    ];
    const tStart = candidateTurnStart(trace, FLOOR_T, adopted);
    expect(tStart).toBe(FLOOR_T + 200);
    expect(tStart).not.toBe(FLOOR_T - 29_000);
  });

  it("never reaches further back than one barge-in's worth of speech", () => {
    const trace: SttTraceEvent[] = [
      // Non-echo, but far too old to be the interjection that took this floor.
      result(FLOOR_T - MAX_EARLY_START_MS - 1000, "totally unrelated corridor noise"),
      result(FLOOR_T + 300, "here is my actual point", true),
    ];
    expect(candidateTurnStart(trace, FLOOR_T, adopted)).toBe(FLOOR_T + 300);
  });

  it("falls back to the moment the floor was taken when nothing was heard", () => {
    expect(candidateTurnStart([{ kind: "start", t: FLOOR_T }], FLOOR_T, adopted)).toBe(FLOOR_T);
    expect(candidateTurnStart([], FLOOR_T, null)).toBe(FLOOR_T);
  });

  it("ignores empty results", () => {
    const trace: SttTraceEvent[] = [result(FLOOR_T + 10, "   "), result(FLOOR_T + 900, "real words", true)];
    expect(candidateTurnStart(trace, FLOOR_T, null)).toBe(FLOOR_T + 900);
  });

  it("a fresh gap-grab session has no echo to reject", () => {
    const trace: SttTraceEvent[] = [{ kind: "start", t: FLOOR_T }, result(FLOOR_T + 700, "my turn now")];
    expect(candidateTurnStart(trace, FLOOR_T, null)).toBe(FLOOR_T + 700);
  });
});

describe("the timeline the report is scored from", () => {
  const T0 = 500_000;
  const FLOOR_T = T0 + 20_000;
  const adopted = { finals: 1, echoRef: PERSONA_LINE };

  it("a backdated turn used to invent airtime and a phantom interjection", () => {
    // The mic opened when the persona started at T0; the candidate only spoke
    // in the gap afterwards. Scored from the first TRACE event, their 3 seconds
    // become 23 and the polite gap-turn becomes an interjection.
    const trace: SttTraceEvent[] = [
      { kind: "start", t: T0 },
      { kind: "result", t: T0 + 1000, text: "AI will destroy manual testing jobs", isFinal: false },
      { kind: "result", t: FLOOR_T + 500, text: "I think the transition matters more", isFinal: true },
    ];
    const persona: Turn = {
      speaker: "interviewer",
      text: PERSONA_LINE,
      tStart: T0,
      tEnd: T0 + 18_000,
      personaId: "dominator",
      personaName: "Vikram",
    };
    const honest: Turn = {
      speaker: "candidate",
      text: "I think the transition matters more",
      tStart: candidateTurnStart(trace, FLOOR_T, adopted),
      tEnd: FLOOR_T + 3000,
    };
    const naive: Turn = { ...honest, tStart: trace[1].kind === "result" ? trace[1].t : 0 };

    const good = airtimeFromTurns([persona, honest], T0);
    const bad = airtimeFromTurns([persona, naive], T0);

    expect(good.candidateAirtimeMs).toBe(2500);
    expect(good.interjections).toHaveLength(0); // spoke in the gap, politely
    expect(bad.candidateAirtimeMs).toBe(22_000); // nine times their real airtime
    expect(bad.interjections).toHaveLength(1); // phantom
    expect(good.airtimeSharePct).toBeLessThan(bad.airtimeSharePct);
  });

  it("a cut-off persona no longer donates unheard words to the next batch", () => {
    const said = spokenPrefix(PERSONA_LINE, 2200);
    expect(said).not.toBe(PERSONA_LINE);
    // What the debate engine is told the room heard is what the room heard.
    expect(PERSONA_LINE.startsWith(said.replace(/—$/, ""))).toBe(true);
  });
});
