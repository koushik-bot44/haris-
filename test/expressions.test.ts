import { describe, expect, it } from "vitest";
import { EXPRESSION_CONTEXTS, expressionsGuidance, reaction, sanitizeForVoice } from "@/lib/expressions";
import { ACK_TEXTS } from "@/lib/ack";
import { splitMoveLine } from "@/lib/interview/moveline";

// Every spelling the production voice (Kokoro) spells out letter by letter,
// measured on 2026-09-14 — see the header of lib/expressions.ts.
const SPELLED_OUT = /\bmm[- ]?hmm?\b|\bmhm\b|\bhm\b|\bmm\b|\(laughs?\)|\*[^*]+\*/i;

describe("interviewer expressions", () => {
  it("offers only spellings the production voice can pronounce", () => {
    for (const ctx of EXPRESSION_CONTEXTS) {
      for (let i = 0; i < 12; i++) {
        const line = reaction(ctx, `seed-${i}`, "kokoro");
        expect(line).not.toMatch(SPELLED_OUT);
        expect(line).not.toMatch(/\[[a-z ]+\]/); // no performed tags on Kokoro
      }
    }
  });

  it("renders a performed tag only for the studio voice", () => {
    const seeds = Array.from({ length: 12 }, (_, i) => `s${i}`);
    expect(seeds.some((s) => reaction("amused", s, "chatterbox").includes("["))).toBe(true);
    expect(seeds.every((s) => !reaction("amused", s, "kokoro").includes("["))).toBe(true);
  });

  it("repairs the spellings a model or a template might still produce", () => {
    expect(sanitizeForVoice("Mm-hm — go on?", "kokoro")).toBe("Uh-huh — go on?");
    expect(sanitizeForVoice("Mm, okay. Hm. Mhm.", "kokoro")).toBe("Hmm, okay. Hmm. Uh-huh.");
    expect(sanitizeForVoice("Hmm, okay — so tell me more.", "kokoro")).toBe("Hmm, okay — so tell me more.");
    expect(sanitizeForVoice("(laughs) That's funny. *smiles* Go on.", "kokoro")).toBe("That's funny. Go on.");
    expect(sanitizeForVoice("[chuckle] Fair enough.", "kokoro")).toBe("Fair enough.");
    expect(sanitizeForVoice("[chuckle] Fair enough. Mm-hm.", "chatterbox")).toBe("[chuckle] Fair enough. Mm-hm.");
  });

  it("the acks the room plays are pronounceable on every engine", () => {
    for (const lines of Object.values(ACK_TEXTS)) for (const l of lines) expect(l).not.toMatch(SPELLED_OUT);
  });

  it("the prompt guidance names only safe spellings and forbids the unsafe ones", () => {
    const g = expressionsGuidance("kokoro");
    expect(g).toContain("Uh-huh");
    expect(g).toContain('Never write "Mm-hm"');
    expect(g).not.toMatch(/\[laugh\]/);
    expect(expressionsGuidance("chatterbox")).toMatch(/\[chuckle\]/);
  });
});

describe("move line hardening", () => {
  it("removes every spelling of the move line from the spoken text", () => {
    expect(splitMoveLine('@@MOVE {"action":"follow_up"}\nOkay, tell me more.')).toEqual({ move: { action: "follow_up" }, rest: "Okay, tell me more." });
    expect(splitMoveLine('@MOVE {"action":"clarify"}\nRight.')).toEqual({ move: { action: "clarify" }, rest: "Right." });
    expect(splitMoveLine('MOVE: {"action":"wrap"}\nThanks.')).toEqual({ move: { action: "wrap" }, rest: "Thanks." });
    expect(splitMoveLine('{"action":"switch_competency","competency":"java"}\nLet us move on.')).toEqual({ move: { action: "switch_competency", competency: "java" }, rest: "Let us move on." });
  });

  it("leaves speech alone when there is no move object", () => {
    expect(splitMoveLine("Move on to the next part — what did you do?")).toEqual({ move: null, rest: "Move on to the next part — what did you do?" });
  });
});
