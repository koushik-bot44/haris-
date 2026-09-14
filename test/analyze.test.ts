import { describe, expect, it } from "vitest";
import { commit, ingest, initState, mergeModelAnalysis } from "@/lib/interview/engine";
import { parseAnalysis, pendingAnswers } from "@/lib/llm/analyze";
import type { HistoryEntry } from "@/lib/types";

// The background assessment is trusted only as far as its quotes verify: a
// score whose "evidence" the candidate never said must never reach the ledger.

const NOW = 1_800_000_000_000;
const ANSWER = "I designed the order service in Spring Boot and added a Redis cache, which cut latency from 900ms to 120ms.";

function setup() {
  let s = initState({ sid: "t", now: NOW, role: "java-sde-fresher", roundType: "technical", candidateName: "Asha" });
  s = commit(s, { kind: "open", text: "Tell me about a project you built?", source: "fallback" }, NOW);
  const history: HistoryEntry[] = [
    { speaker: "interviewer", text: "Tell me about a project you built?" },
    { speaker: "candidate", text: ANSWER },
  ];
  return { state: ingest(s, history, NOW + 1000).state, history };
}

describe("background answer analysis", () => {
  it("queues the newest substantive, not-yet-analysed answers", () => {
    const { state, history } = setup();
    expect(pendingAnswers(state, history)).toEqual([1]);
    expect(pendingAnswers({ ...state, modelAnalyzed: [1] }, history)).toEqual([]);
  });

  it("parses tolerantly: junk items and competencies outside the plan are dropped", () => {
    const { state } = setup();
    const raw = `Sure! {"answers":[{"index":1,"competencies":[{"id":"projects","score":4,"quality":"strong","quote":"added a Redis cache"},{"id":"astrology","score":5,"quality":"strong","quote":"x"},{"id":"java"}],"rubric":{"scores":{"relevance":4,"structure":3,"depth":4,"communication":4},"evidence":{"depth":"cut latency from 900ms to 120ms"},"tips":{"structure":"Lead with the result."}},"claims":[{"text":"designed the order service","area":"backend","kind":"ownership","polarity":1,"quote":"I designed the order service"}],"contradictions":[],"incorrect":""},{"index":99,"competencies":[]}]}`;
    const parsed = parseAnalysis(raw, [1], state);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].competencies.map((c) => c.id)).toEqual(["projects"]);
    expect(parsed[0].rubric?.scores.depth).toBe(4);
    expect(parseAnalysis("not json at all", [1], state)).toEqual([]);
  });

  it("merges only verified quotes: a fabricated one adds no score, claim or rubric evidence", () => {
    const { state, history } = setup();
    const merged = mergeModelAnalysis(
      state,
      [
        {
          index: 1,
          competencies: [
            { id: "projects", score: 4, quality: "strong", quote: "added a Redis cache", strength: "measured impact" },
            { id: "dsa", score: 5, quality: "strong", quote: "I implemented a red-black tree from scratch" },
          ],
          rubric: {
            scores: { relevance: 4, structure: 3, depth: 4, communication: 4 },
            evidence: { depth: "cut latency from 900ms to 120ms", relevance: "words never spoken" },
            tips: {},
          },
          claims: [{ text: "led a team of ten", area: "team", kind: "role", polarity: 1, quote: "I led a team of ten engineers" }],
          contradictions: [],
          incorrect: null,
        },
      ],
      history,
      NOW + 2000,
    );
    expect(merged.ledger.projects.evidence.find((e) => e.turn === 1)?.source).toBe("model");
    expect(merged.ledger.dsa.evidence.some((e) => e.source === "model")).toBe(false);
    const thread = merged.threads.find((t) => t.answers.includes(1));
    expect(thread?.source).toBe("model");
    expect(thread?.entry?.evidence.depth).toBe("cut latency from 900ms to 120ms");
    expect(thread?.entry?.evidence.relevance).toBeUndefined();
    expect(merged.claims.some((c) => c.text === "led a team of ten")).toBe(false);
    expect(merged.modelAnalyzed).toContain(1);
  });
});

describe("model claims and contradictions are checked for plausibility", () => {
  it("stores a model claim in the candidate's own first-person-stripped words", () => {
    const { state, history } = setup();
    const merged = mergeModelAnalysis(
      state,
      [{ index: 1, competencies: [], rubric: null, claims: [{ text: "Candidate designed the order service", area: "backend", kind: "ownership", polarity: 1, quote: "I designed the order service in Spring Boot" }], contradictions: [], incorrect: null }],
      history,
      NOW + 2000,
    );
    const claim = merged.claims.find((c) => c.source === "model");
    expect(claim?.text).toBe("designed the order service in Spring Boot");
    expect(claim?.text).not.toMatch(/candidate/i);
  });

  it("drops a model-reported contradiction that is not about the earlier claim", () => {
    const { state, history } = setup();
    const earlier = state.claims.find((c) => c.source !== "resume") ?? state.claims[0];
    const merged = mergeModelAnalysis(
      state,
      [{ index: 1, competencies: [], rubric: null, claims: [], contradictions: [{ claimId: earlier.id, quote: "which cut latency from 900ms to 120ms", explanation: "different topic" }], incorrect: null }],
      history,
      NOW + 2000,
    );
    expect(merged.contradictions).toHaveLength(0);
  });
});
