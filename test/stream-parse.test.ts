import { describe, expect, it } from "vitest";
import { accumulateSpokenText, firstSentence, parseSseEvents, remainderAfter } from "@/lib/stream";

describe("accumulateSpokenText (spoken text vs @@CTRL control line)", () => {
  it("returns the whole buffer as text while no control line exists", () => {
    expect(accumulateSpokenText("Good answer. Now tell me")).toEqual({
      text: "Good answer. Now tell me",
      ctrlLine: null,
    });
  });

  it("splits at a line-initial @@CTRL and captures the control line", () => {
    const buf = 'Good answer. Now tell me more.\n@@CTRL {"type":"followup","questionIndex":2,"done":false}';
    expect(accumulateSpokenText(buf)).toEqual({
      text: "Good answer. Now tell me more.",
      ctrlLine: '@@CTRL {"type":"followup","questionIndex":2,"done":false}',
    });
  });

  it("handles @@CTRL as the very first line (empty spoken text)", () => {
    const out = accumulateSpokenText('@@CTRL {"type":"question","questionIndex":1,"done":false}');
    expect(out.text).toBe("");
    expect(out.ctrlLine).toBe('@@CTRL {"type":"question","questionIndex":1,"done":false}');
  });

  it("withholds a partial line-initial @@CT… tail from the text", () => {
    expect(accumulateSpokenText("First sentence done.\n@@CT")).toEqual({
      text: "First sentence done.",
      ctrlLine: null,
    });
    expect(accumulateSpokenText("First sentence done.\n@")).toEqual({
      text: "First sentence done.",
      ctrlLine: null,
    });
  });

  it("does NOT treat a mid-line @@CTRL as a control line", () => {
    const buf = "Email me @@CTRL details later.";
    expect(accumulateSpokenText(buf)).toEqual({ text: buf, ctrlLine: null });
  });

  it("keeps a non-marker last line in the text", () => {
    expect(accumulateSpokenText("Line one.\nAnd").text).toBe("Line one.\nAnd");
  });

  it("only the control line's own line is the ctrlLine (nothing after a newline)", () => {
    const out = accumulateSpokenText('Hi there, Hari.\n@@CTRL {"done":true}\n');
    expect(out.ctrlLine).toBe('@@CTRL {"done":true}');
    expect(out.text).toBe("Hi there, Hari.");
  });
});

describe("firstSentence (voice-pipelining boundary)", () => {
  it("returns null while no sentence has completed", () => {
    expect(firstSentence("Tell me about your final year")).toBeNull();
    expect(firstSentence("")).toBeNull();
  });

  it("detects a complete sentence ending in . ! or ?", () => {
    expect(firstSentence("That is a solid answer. Now go deeper.")).toBe("That is a solid answer.");
    expect(firstSentence("What a great project! Tell me more.")).toBe("What a great project!");
    expect(firstSentence("Why did you choose Java? It matters.")).toBe("Why did you choose Java?");
  });

  it("accepts end-of-buffer as a boundary (punctuation just streamed in)", () => {
    expect(firstSentence("Walk me through your project.")).toBe("Walk me through your project.");
  });

  it("skips boundaries under the 12-char minimum", () => {
    expect(firstSentence("Hi. Tell me about yourself.")).toBe("Hi. Tell me about yourself.");
    expect(firstSentence("Okay.")).toBeNull();
  });

  it("does not split inside numbers or attached tokens", () => {
    expect(firstSentence("You scored 8.5 CGPA overall. Impressive work.")).toBe("You scored 8.5 CGPA overall.");
  });

  it("is abbreviation-safe for titles and latin abbreviations", () => {
    expect(firstSentence("You worked with Dr. Rao for two years, correct? Good.")).toBe(
      "You worked with Dr. Rao for two years, correct?",
    );
    expect(firstSentence("Pick one language, e.g. Java maybe. Why that one?")).toBe(
      "Pick one language, e.g. Java maybe.",
    );
  });

  it("treats single-letter initials as abbreviations", () => {
    expect(firstSentence("You did your B. Tech at VIT, right? Nice.")).toBe("You did your B. Tech at VIT, right?");
  });
});

describe("remainderAfter (chained second utterance)", () => {
  it("returns the text after an exact spoken prefix, trimmed", () => {
    expect(remainderAfter("First sentence here. Second part follows.", "First sentence here.")).toBe(
      "Second part follows.",
    );
  });

  it("tolerates leading whitespace differences", () => {
    expect(remainderAfter("  First sentence here. Rest.", "First sentence here.")).toBe("Rest.");
  });

  it("returns everything when nothing was spoken yet", () => {
    expect(remainderAfter(" Full turn text. ", "")).toBe("Full turn text.");
  });

  it("returns empty when the spoken text is gone from the final text (never double-speaks)", () => {
    expect(remainderAfter("A completely different reply.", "What was streamed before.")).toBe("");
  });

  it("returns empty when the turn IS exactly the spoken sentence", () => {
    expect(remainderAfter("Short complete reply.", "Short complete reply.")).toBe("");
  });
});

describe("parseSseEvents (interview route SSE frames)", () => {
  it("parses complete data frames and keeps the partial remainder", () => {
    const buf =
      'data: {"kind":"text","text":"Hello"}\n\n' +
      'data: {"kind":"text","text":"Hello there"}\n\n' +
      'data: {"kind":"tur';
    const { events, rest } = parseSseEvents(buf);
    expect(events).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: "Hello there" },
    ]);
    expect(rest).toBe('data: {"kind":"tur');
  });

  it("parses the final turn event with its provider", () => {
    const turn = { type: "question", text: "Why us?", questionIndex: 2, done: false };
    const { events } = parseSseEvents(`data: ${JSON.stringify({ kind: "turn", turn, provider: "claude-cli" })}\n\n`);
    expect(events).toEqual([{ kind: "turn", turn, provider: "claude-cli" }]);
  });

  it("parses error events", () => {
    const { events } = parseSseEvents('data: {"kind":"error","error":"interviewer_unavailable","kind2":"unavailable"}\n\n');
    expect(events[0]).toEqual({ kind: "error", error: "interviewer_unavailable", kind2: "unavailable" });
  });

  it("skips malformed JSON and unknown kinds without dying", () => {
    const buf = 'data: {not json}\n\ndata: {"kind":"mystery"}\n\ndata: {"kind":"text","text":"ok"}\n\n';
    const { events, rest } = parseSseEvents(buf);
    expect(events).toEqual([{ kind: "text", text: "ok" }]);
    expect(rest).toBe("");
  });

  it("ignores comment/non-data lines and tolerates CRLF", () => {
    const buf = ': keepalive\n\ndata: {"kind":"text","text":"hi"}\r\n\n';
    const { events } = parseSseEvents(buf);
    expect(events).toEqual([{ kind: "text", text: "hi" }]);
  });

  it("returns everything as rest when no frame is complete", () => {
    const { events, rest } = parseSseEvents('data: {"kind":"text"');
    expect(events).toEqual([]);
    expect(rest).toBe('data: {"kind":"text"');
  });
});
