import { describe, expect, it } from "vitest";
import {
  guidanceCacheKey,
  guidanceSchema,
  heuristicGuidance,
  type GuidancePerformance,
} from "@/lib/llm/guidance";
import { shortHash } from "@/lib/guidance-key";
import type { RolePreset } from "@/lib/types";

const ROLES: RolePreset[] = ["general", "java-sde-fresher", "frontend-fresher"];
const cold: GuidancePerformance = { avgScore: null, weakestCriterion: null, sessionsCount: 0 };
const warm: GuidancePerformance = { avgScore: 2.4, weakestCriterion: "structure", sessionsCount: 3 };

describe("heuristicGuidance (the curated quality floor)", () => {
  it("is deterministic for identical inputs", () => {
    for (const role of ROLES) {
      expect(heuristicGuidance(role, cold)).toEqual(heuristicGuidance(role, cold));
      expect(heuristicGuidance(role, warm)).toEqual(heuristicGuidance(role, warm));
    }
  });

  it("passes the full guidance schema for every role preset, cold and warm", () => {
    for (const role of ROLES) {
      expect(guidanceSchema.safeParse(heuristicGuidance(role, cold)).success).toBe(true);
      expect(guidanceSchema.safeParse(heuristicGuidance(role, warm)).success).toBe(true);
    }
  });

  it("front-loads the weakest mock criterion as the first gap", () => {
    const s = heuristicGuidance("general", { avgScore: 4.2, weakestCriterion: "structure", sessionsCount: 2 });
    expect(s.skillGaps[0]).toMatch(/situation/i);
    const d = heuristicGuidance("general", { avgScore: 4.2, weakestCriterion: "depth", sessionsCount: 2 });
    expect(d.skillGaps[0]).toMatch(/specifics/i);
  });

  it("adds an interview-reps gap when the mock average is under 3, capped at 5", () => {
    const g = heuristicGuidance("java-sde-fresher", { avgScore: 2.1, weakestCriterion: "depth", sessionsCount: 4 });
    expect(g.skillGaps.some((s) => /under 3\/5/.test(s))).toBe(true);
    expect(g.skillGaps.length).toBeLessThanOrEqual(5);
    expect(guidanceSchema.safeParse(g).success).toBe(true);
  });

  it("adds no reps gap when there are no scored rounds", () => {
    const g = heuristicGuidance("general", { avgScore: 2, weakestCriterion: null, sessionsCount: 0 });
    expect(g.skillGaps.some((s) => /under 3\/5/.test(s))).toBe(false);
  });

  it("recommends real India-hiring companies per role", () => {
    const companies = (role: RolePreset) => heuristicGuidance(role, cold).roles.flatMap((r) => r.companies);
    expect(companies("general")).toContain("TCS");
    expect(companies("java-sde-fresher")).toContain("Amazon India");
    expect(companies("frontend-fresher")).toContain("Zoho");
  });

  it("never emits a URL as a learning resource (resource is a TYPE, not a link)", () => {
    for (const role of ROLES) {
      for (const step of heuristicGuidance(role, warm).learningPath) {
        expect(step.resource).not.toMatch(/https?:\/\//);
      }
    }
  });

  it("learning paths are real sequences: 2-5 ordered steps with all three fields", () => {
    for (const role of ROLES) {
      const path = heuristicGuidance(role, cold).learningPath;
      expect(path.length).toBeGreaterThanOrEqual(2);
      expect(path.length).toBeLessThanOrEqual(5);
      for (const step of path) {
        expect(step.skill.length).toBeGreaterThan(0);
        expect(step.why.length).toBeGreaterThan(0);
        expect(step.resource.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("guidanceSchema rejections (LLM output hardening)", () => {
  const valid = heuristicGuidance("general", cold);

  it("rejects missing sections", () => {
    expect(guidanceSchema.safeParse({}).success).toBe(false);
    const noRoles = { ...valid } as Record<string, unknown>;
    delete noRoles.roles;
    expect(guidanceSchema.safeParse(noRoles).success).toBe(false);
  });

  it("rejects too-few and too-many items per section", () => {
    expect(guidanceSchema.safeParse({ ...valid, skillGaps: ["only one"] }).success).toBe(false);
    expect(guidanceSchema.safeParse({ ...valid, certifications: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    expect(guidanceSchema.safeParse({ ...valid, learningPath: valid.learningPath.slice(0, 1) }).success).toBe(false);
  });

  it("rejects roles with company lists outside 2-4", () => {
    const one = { ...valid, roles: [{ ...valid.roles[0], companies: ["TCS"] }, valid.roles[1]] };
    expect(guidanceSchema.safeParse(one).success).toBe(false);
    const five = { ...valid, roles: [{ ...valid.roles[0], companies: ["A", "B", "C", "D", "E"] }, valid.roles[1]] };
    expect(guidanceSchema.safeParse(five).success).toBe(false);
  });

  it("rejects non-string members and empty strings", () => {
    expect(guidanceSchema.safeParse({ ...valid, skillGaps: ["ok", 7] }).success).toBe(false);
    expect(guidanceSchema.safeParse({ ...valid, certifications: ["", "x"] }).success).toBe(false);
  });
});

describe("guidanceCacheKey (client cache key — pure)", () => {
  it("is deterministic", () => {
    expect(guidanceCacheKey("general", 3, 3.5, "structure", "resume text")).toBe(
      guidanceCacheKey("general", 3, 3.5, "structure", "resume text"),
    );
  });

  it("changes when any input changes", () => {
    const base = guidanceCacheKey("general", 3, 3.5, "structure", "my resume");
    expect(guidanceCacheKey("java-sde-fresher", 3, 3.5, "structure", "my resume")).not.toBe(base);
    expect(guidanceCacheKey("general", 4, 3.5, "structure", "my resume")).not.toBe(base);
    expect(guidanceCacheKey("general", 3, 3.6, "structure", "my resume")).not.toBe(base);
    expect(guidanceCacheKey("general", 3, 3.5, "depth", "my resume")).not.toBe(base);
    expect(guidanceCacheKey("general", 3, 3.5, "structure", "a different resume")).not.toBe(base);
  });

  it("distinguishes a null average from zero", () => {
    expect(guidanceCacheKey("general", 0, null, null, undefined)).not.toBe(
      guidanceCacheKey("general", 0, 0, null, undefined),
    );
  });

  it("invalidates when a resume is pasted (none → text) or removed", () => {
    const without = guidanceCacheKey("general", 3, 3.5, null, undefined);
    const withResume = guidanceCacheKey("general", 3, 3.5, null, "B.Tech CSE, Java, two projects");
    expect(withResume).not.toBe(without);
    expect(guidanceCacheKey("general", 3, 3.5, null, "")).toBe(without); // empty = no resume
  });

  it("distinguishes a null weakest criterion from a set one", () => {
    expect(guidanceCacheKey("general", 3, 3.5, null, undefined)).not.toBe(
      guidanceCacheKey("general", 3, 3.5, "communication", undefined),
    );
  });
});

describe("shortHash (resume fingerprint — pure djb2)", () => {
  it("is deterministic and input-sensitive", () => {
    expect(shortHash("hello resume")).toBe(shortHash("hello resume"));
    expect(shortHash("hello resume")).not.toBe(shortHash("hello resume!"));
    expect(shortHash("")).toBe(shortHash(""));
  });

  it("only the first 4000 chars participate (bounded work)", () => {
    const head = "x".repeat(4000);
    expect(shortHash(head + "tail-a")).toBe(shortHash(head + "tail-b"));
    expect(shortHash(head)).toBe(shortHash(head + "anything"));
  });

  it("emits a compact url/key-safe token", () => {
    expect(shortHash("some resume text")).toMatch(/^[0-9a-z]{1,7}$/);
  });
});
