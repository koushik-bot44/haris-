import { describe, expect, it } from "vitest";
import {
  clampTurn,
  deriveProgress,
  HARD_STOP_ANSWERS,
  parseInterviewerJson,
  parseStreamedTurn,
  transcriptFor,
  visibleStreamText,
} from "@/lib/llm/parse";
import type { HistoryEntry } from "@/lib/types";

describe("interviewer JSON parsing (LLM provider hardening)", () => {
  it("parses clean minified JSON", () => {
    const t = parseInterviewerJson('{"type":"question","text":"Why us?","questionIndex":2,"done":false}');
    expect(t).toEqual({ type: "question", text: "Why us?", questionIndex: 2, done: false });
  });

  it("tolerates code fences and surrounding prose", () => {
    const raw = 'Sure! Here is the JSON:\n```json\n{"type":"greeting","text":"Hello Hari.","questionIndex":0,"done":false}\n```';
    expect(parseInterviewerJson(raw)?.type).toBe("greeting");
  });

  it("returns null on malformed JSON and on wrong shapes", () => {
    expect(parseInterviewerJson("I would ask about teamwork next.")).toBeNull();
    expect(parseInterviewerJson('{"type":"question"}')).toBeNull();
    expect(parseInterviewerJson('{"type":"lecture","text":"x","questionIndex":1,"done":false}')).toBeNull();
  });

  it("clamps out-of-range questionIndex instead of failing", () => {
    const t = parseInterviewerJson('{"type":"question","text":"Q","questionIndex":9,"done":false}');
    expect(t?.questionIndex).toBe(0); // zod .catch(0)
  });

  it("force-wraps runaway interviews at the hard stop", () => {
    const history: HistoryEntry[] = [];
    for (let i = 0; i < HARD_STOP_ANSWERS; i++) {
      history.push({ speaker: "interviewer", text: `Q${i}` }, { speaker: "candidate", text: `A${i}` });
    }
    const progress = deriveProgress(history);
    const clamped = clampTurn({ type: "question", text: "One more…", questionIndex: 5, done: false }, progress);
    expect(clamped.done).toBe(true);
    expect(clamped.type).toBe("wrapup");
  });

  it("gives deep-dive chains room: hard stop is 16, and never fires below it", () => {
    expect(HARD_STOP_ANSWERS).toBe(16);
    const history: HistoryEntry[] = [];
    for (let i = 0; i < HARD_STOP_ANSWERS - 1; i++) {
      history.push({ speaker: "interviewer", text: `Q${i}` }, { speaker: "candidate", text: `A${i}` });
    }
    const turn = clampTurn({ type: "followup", text: "Go deeper…", questionIndex: 5, done: false }, deriveProgress(history));
    expect(turn.done).toBe(false);
    expect(turn.type).toBe("followup");
  });
});

describe("parseStreamedTurn (spoken text + @@CTRL protocol)", () => {
  it("parses text lines followed by a control line", () => {
    const raw = 'Good point about indexing.\nHow would you shard that table?\n@@CTRL {"type":"followup","questionIndex":3,"done":false,"coding":false}';
    expect(parseStreamedTurn(raw)).toEqual({
      type: "followup",
      text: "Good point about indexing.\nHow would you shard that table?",
      questionIndex: 3,
      done: false,
      // Omitted by the model, inferred from the act: a followup is a probe.
      asked: true,
    });
  });

  it("carries an explicit asked:false — a turn that only answers the candidate", () => {
    const raw = 'I\'m Priya, HR here at Meridian.\n@@CTRL {"type":"reply","questionIndex":0,"asked":false,"done":false}';
    expect(parseStreamedTurn(raw)).toEqual({
      type: "reply",
      text: "I'm Priya, HR here at Meridian.",
      questionIndex: 0,
      done: false,
      asked: false,
    });
  });

  it("carries coding:true through; drops coding:false entirely", () => {
    const coding = parseStreamedTurn('Open the editor.\n@@CTRL {"type":"question","questionIndex":3,"done":false,"coding":true}');
    expect(coding?.coding).toBe(true);
    const spoken = parseStreamedTurn('Tell me more.\n@@CTRL {"type":"question","questionIndex":2,"done":false,"coding":false}');
    expect(spoken && "coding" in spoken).toBe(false);
  });

  // With no control line there is no claim that a topic was opened, so the turn
  // degrades to conversation, not to interview progress. `asked` is inferred
  // from the text so a real question still counts.
  it("missing @@CTRL: the reply is conversational, and a question mark still counts as asking", () => {
    const t = parseStreamedTurn("So tell me, why did you pick MongoDB over Postgres there?");
    expect(t).toEqual({
      type: "reply",
      text: "So tell me, why did you pick MongoDB over Postgres there?",
      questionIndex: 0,
      done: false,
      asked: true,
    });
  });

  it("missing @@CTRL on a turn that asks nothing does not count as asking", () => {
    const t = parseStreamedTurn("No rush at all — take your time.");
    expect(t?.asked).toBe(false);
    expect(t?.type).toBe("reply");
  });

  it("junk control fields degrade to catch defaults instead of losing the turn", () => {
    const t = parseStreamedTurn('Interesting answer.\n@@CTRL {"type":"lecture","questionIndex":99,"done":"yes"}');
    expect(t).toEqual({
      type: "reply",
      text: "Interesting answer.",
      questionIndex: 0,
      done: false,
      asked: false,
    });
  });

  it("unparseable control JSON keeps the speech with default control fields", () => {
    const t = parseStreamedTurn("Nice work on that.\n@@CTRL not-even-json");
    expect(t).toEqual({
      type: "reply",
      text: "Nice work on that.",
      questionIndex: 0,
      done: false,
      asked: false,
    });
  });

  // Observed live: the model answered, then emitted its control line as
  // `@{"type":"reply","asking":false,"answered":true,"topic":0}`. The old
  // parser only knew "@@CTRL", so the JSON was treated as speech — spoken by
  // the TTS and printed in the caption mid-interview.
  it("recognises an improvised control marker instead of speaking the JSON", () => {
    const raw = 'Oh, nice to meet you, Koushik.\n@{"type":"reply","asking":false,"answered":true,"topic":0}';
    const t = parseStreamedTurn(raw);
    expect(t?.text).toBe("Oh, nice to meet you, Koushik.");
    expect(t?.text).not.toContain("{");
    expect(t?.type).toBe("reply");
    expect(t?.questionIndex).toBe(0);
    expect(t?.asked).toBe(false);
  });

  it("maps the model's alias field names onto the real ones", () => {
    const t = parseStreamedTurn('Tell me about that project.\n@@CTRL {"type":"question","topic":3,"asking":true}');
    expect(t?.questionIndex).toBe(3);
    expect(t?.asked).toBe(true);
  });

  it("never lets a bare control object reach the spoken text", () => {
    const t = parseStreamedTurn('Good answer.\n{"type":"followup","questionIndex":2,"done":false}');
    expect(t?.text).toBe("Good answer.");
    expect(t?.questionIndex).toBe(2);
  });

  it("withholds a partial improvised marker while streaming", () => {
    expect(visibleStreamText("Nice work on that.\n@{")).toBe("Nice work on that.");
    expect(visibleStreamText('Nice work.\n@{"type":"rep')).toBe("Nice work.");
  });

  // Behaviour changed deliberately. The marker used to count only at the start
  // of a line, so an inline one was spoken aloud — and models emit inline
  // markers routinely (observed: `Hello Rohan, nice to finally dig in. @@CTRL
  // {"type":"greeting",...}` on one line). Speaking JSON at a candidate is a
  // far worse failure than truncating the rare turn that discusses the literal
  // token, so the marker now ends the speech wherever it appears.
  it("treats an inline @@CTRL as the end of speech, not as spoken content", () => {
    const raw = 'Hello Rohan, nice to finally dig in. @@CTRL {"type":"greeting","questionIndex":0,"done":false}';
    const t = parseStreamedTurn(raw);
    expect(t?.text).toBe("Hello Rohan, nice to finally dig in.");
    expect(t?.text).not.toContain("@@CTRL");
    expect(t?.type).toBe("greeting");
  });

  it("returns null on empty input and on a control line with no speech", () => {
    expect(parseStreamedTurn("")).toBeNull();
    expect(parseStreamedTurn("   \n ")).toBeNull();
    expect(parseStreamedTurn('@@CTRL {"type":"question","questionIndex":1,"done":false}')).toBeNull();
  });

  it("parses a done wrapup", () => {
    const t = parseStreamedTurn('Thanks, that was a strong round.\n@@CTRL {"type":"wrapup","questionIndex":0,"done":true}');
    expect(t?.type).toBe("wrapup");
    expect(t?.done).toBe(true);
  });
});

describe("visibleStreamText (streaming withhold rules)", () => {
  it("passes plain accumulated text through, trimmed", () => {
    expect(visibleStreamText("Good point.\nNow tell me ")).toBe("Good point.\nNow tell me");
  });

  it("cuts at a line-initial @@CTRL even while the control JSON is partial", () => {
    expect(visibleStreamText('Good point.\n@@CTRL {"type":"que')).toBe("Good point.");
  });

  it("withholds a trailing partial @@CTRL prefix until disambiguated", () => {
    expect(visibleStreamText("Good point.\n@@C")).toBe("Good point.");
    expect(visibleStreamText("Good point.\n@")).toBe("Good point.");
  });

  // Matches the parser: an inline marker ends the speech while streaming too,
  // so the TTS never starts saying "at at C T R L" before the turn resolves.
  it("cuts at an inline @@CTRL rather than streaming it to the voice", () => {
    expect(visibleStreamText("I saw @@CTRL in your code")).toBe("I saw");
  });
});

describe("transcriptFor persona labeling", () => {
  const history: HistoryEntry[] = [
    { speaker: "interviewer", text: "Hello." },
    { speaker: "candidate", text: "Hi there." },
  ];

  it("defaults the interviewer label to 'Interviewer'", () => {
    expect(transcriptFor(history)).toBe("Interviewer: Hello.\nCandidate: Hi there.");
  });

  it("labels the interviewer with the given persona name", () => {
    expect(transcriptFor(history, "Arjun")).toBe("Arjun: Hello.\nCandidate: Hi there.");
  });
});
