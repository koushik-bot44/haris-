import { describe, expect, it } from "vitest";
import { clampTurn, deriveProgress, HARD_STOP_ANSWERS, parseInterviewerJson, transcriptFor } from "@/lib/llm/parse";
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
