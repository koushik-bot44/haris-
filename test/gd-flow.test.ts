import { describe, expect, it } from "vitest";
import {
  computeGdTurns,
  GD_WRAP_AFTER,
  gdOpening,
  gdWrapup,
  isGdWrapTurn,
  keywordOf,
} from "@/lib/gd/flow";
import { GD_TOPICS } from "@/lib/fixtures/gd-topics";
import type { GdHistoryEntry, GdTurn } from "@/lib/types";

const TOPIC = GD_TOPICS[0].topic;
const VALID_IDS = new Set(["moderator", "dominator", "data", "fence"]);

/** Drive the engine batch-by-batch (no candidate) until the moderator wraps. */
function playToWrap(topic: string, name: string): GdTurn[] {
  const history: GdHistoryEntry[] = [];
  const all: GdTurn[] = [];
  for (let guard = 0; guard < 20; guard++) {
    const batch = computeGdTurns(topic, name, history, 3);
    if (batch.length === 0) break;
    for (const t of batch) {
      all.push(t);
      history.push({ personaId: t.personaId, text: t.text });
    }
    if (all.some(isGdWrapTurn)) break;
  }
  return all;
}

describe("gd flow engine", () => {
  it("opens with the moderator introducing topic and candidate", () => {
    const turns = computeGdTurns(TOPIC, "Hari", [], 3);
    expect(turns[0].personaId).toBe("moderator");
    expect(turns[0].text).toContain(TOPIC);
    expect(turns[0].text).toContain("Hari");
  });

  it("returns at most wantTurns turns with valid persona ids, never the candidate", () => {
    const turns = computeGdTurns(TOPIC, "Hari", [], 3);
    expect(turns.length).toBeLessThanOrEqual(3);
    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) {
      expect(VALID_IDS.has(t.personaId)).toBe(true);
      expect(t.personaId).not.toBe("candidate");
      expect(t.text.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic for the same topic, candidate, and history", () => {
    const history: GdHistoryEntry[] = [
      { personaId: "moderator", text: gdOpening(TOPIC, "Hari") },
      { personaId: "candidate", text: "I think automation changes entry level hiring" },
    ];
    const a = computeGdTurns(TOPIC, "Hari", history, 3);
    const b = computeGdTurns(TOPIC, "Hari", history, 3);
    expect(a).toEqual(b);
  });

  it("reacts to the candidate's last point with a keyword echo", () => {
    const history: GdHistoryEntry[] = [
      { personaId: "moderator", text: gdOpening(TOPIC, "Hari") },
      { personaId: "dominator", text: "AI obviously creates jobs, no debate." },
      { personaId: "candidate", text: "The real issue is blockchain based payroll fraud" },
    ];
    const turns = computeGdTurns(TOPIC, "Hari", history, 3);
    expect(turns[0].text.toLowerCase()).toContain("blockchain");
  });

  it("only the first turn after the candidate carries the echo", () => {
    const history: GdHistoryEntry[] = [
      { personaId: "moderator", text: gdOpening(TOPIC, "Hari") },
      { personaId: "dominator", text: "AI obviously creates jobs, no debate." },
      { personaId: "candidate", text: "The real issue is blockchain based payroll fraud" },
    ];
    const turns = computeGdTurns(TOPIC, "Hari", history, 3);
    for (const t of turns.slice(1)) {
      expect(t.text.toLowerCase()).not.toContain("blockchain");
    }
  });

  it("moderator interjects periodically but never twice in a row", () => {
    const all = playToWrap(TOPIC, "Hari");
    const modTurns = all.filter((t) => t.personaId === "moderator");
    // opening + at least two mid-debate appearances + wrap
    expect(modTurns.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < all.length; i++) {
      expect(all[i].personaId === "moderator" && all[i - 1].personaId === "moderator").toBe(false);
    }
  });

  it("invites the quiet candidate by name mid-discussion", () => {
    const all = playToWrap(TOPIC, "Hari");
    // exclude the opening (which also names the candidate) and the wrap
    const middle = all.slice(1, -1);
    expect(middle.some((t) => t.personaId === "moderator" && t.text.includes("Hari"))).toBe(true);
  });

  it("the dominator hogs the floor relative to the fence-sitter", () => {
    const all = playToWrap(TOPIC, "Hari");
    const count = (id: string) => all.filter((t) => t.personaId === id).length;
    expect(count("dominator")).toBeGreaterThanOrEqual(count("fence"));
    expect(count("dominator")).toBeGreaterThanOrEqual(count("data"));
  });

  it("wraps after ~GD_WRAP_AFTER persona turns and stays silent afterwards", () => {
    const all = playToWrap(TOPIC, "Hari");
    expect(isGdWrapTurn(all[all.length - 1])).toBe(true);
    expect(all.length).toBeLessThanOrEqual(GD_WRAP_AFTER + 1);
    const history: GdHistoryEntry[] = all.map((t) => ({ personaId: t.personaId, text: t.text }));
    expect(computeGdTurns(TOPIC, "Hari", history, 3)).toEqual([]);
  });

  it("handles custom topics through the generic stance fallback", () => {
    const turns = computeGdTurns("Cats make better teammates than dogs", "Hari", [], 3);
    expect(turns.length).toBe(3);
    expect(turns[0].personaId).toBe("moderator");
    expect(turns[0].text).toContain("Cats make better teammates than dogs");
  });

  it("returns [] for a non-positive wantTurns", () => {
    expect(computeGdTurns(TOPIC, "Hari", [], 0)).toEqual([]);
    expect(computeGdTurns(TOPIC, "Hari", [], -2)).toEqual([]);
  });

  it("keywordOf picks the longest substantive word and skips stopwords", () => {
    expect(keywordOf("I think blockchain is the real issue")).toBe("blockchain");
    expect(keywordOf("that this with have")).toBeNull();
    expect(keywordOf("")).toBeNull();
  });

  it("wrap helpers agree with isGdWrapTurn", () => {
    const wrap: GdTurn = { personaId: "moderator", text: gdWrapup(TOPIC, "Hari") };
    expect(isGdWrapTurn(wrap)).toBe(true);
    expect(isGdWrapTurn({ personaId: "moderator", text: gdOpening(TOPIC, "Hari") })).toBe(false);
    expect(isGdWrapTurn({ personaId: "dominator", text: gdWrapup(TOPIC, "Hari") })).toBe(false);
  });
});
