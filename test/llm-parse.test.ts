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
    });
  });

  it("carries coding:true through; drops coding:false entirely", () => {
    const coding = parseStreamedTurn('Open the editor.\n@@CTRL {"type":"question","questionIndex":3,"done":false,"coding":true}');
    expect(coding?.coding).toBe(true);
    const spoken = parseStreamedTurn('Tell me more.\n@@CTRL {"type":"question","questionIndex":2,"done":false,"coding":false}');
    expect(spoken && "coding" in spoken).toBe(false);
  });

  it("missing @@CTRL: the whole reply becomes question text with index 0", () => {
    const t = parseStreamedTurn("So tell me, why did you pick MongoDB over Postgres there?");
    expect(t).toEqual({
      type: "question",
      text: "So tell me, why did you pick MongoDB over Postgres there?",
      questionIndex: 0,
      done: false,
    });
  });

  it("junk control fields degrade to catch defaults instead of losing the turn", () => {
    const t = parseStreamedTurn('Interesting answer.\n@@CTRL {"type":"lecture","questionIndex":99,"done":"yes"}');
    expect(t).toEqual({ type: "question", text: "Interesting answer.", questionIndex: 0, done: false });
  });

  it("unparseable control JSON keeps the speech with default control fields", () => {
    const t = parseStreamedTurn("Nice work on that.\n@@CTRL not-even-json");
    expect(t).toEqual({ type: "question", text: "Nice work on that.", questionIndex: 0, done: false });
  });

  it("@@CTRL mid-text is spoken content — only line-initial counts", () => {
    const raw = 'I noticed @@CTRL appears in your code sample. Why?\n@@CTRL {"type":"question","questionIndex":4,"done":false}';
    const t = parseStreamedTurn(raw);
    expect(t?.text).toBe("I noticed @@CTRL appears in your code sample. Why?");
    expect(t?.questionIndex).toBe(4);
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

  it("keeps mid-line @@CTRL mentions — they are spoken content", () => {
    expect(visibleStreamText("I saw @@CTRL in your code")).toBe("I saw @@CTRL in your code");
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
