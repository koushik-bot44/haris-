import { describe, expect, it } from "vitest";
import { interviewRequestSchema } from "@/lib/interview-schema";

const valid = {
  role: "general",
  roundType: "hr",
  candidateName: "Hari",
  history: [
    { speaker: "interviewer", text: "Hello" },
    { speaker: "candidate", text: "Hi" },
  ],
};

describe("interview request validation (proxy hardening)", () => {
  it("accepts a well-shaped request", () => {
    expect(interviewRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects unknown roles (enum, not free text)", () => {
    expect(interviewRequestSchema.safeParse({ ...valid, role: "prompt-injection" }).success).toBe(false);
  });

  it("rejects non-hr round types until they ship", () => {
    expect(interviewRequestSchema.safeParse({ ...valid, roundType: "gd" }).success).toBe(false);
  });

  it("caps history length (the proxy is not a free general LLM API)", () => {
    const history = Array.from({ length: 49 }, () => ({ speaker: "candidate" as const, text: "x" }));
    expect(interviewRequestSchema.safeParse({ ...valid, history }).success).toBe(false);
  });

  it("caps per-message length (6000 — code answers are longer than speech)", () => {
    const over = [{ speaker: "candidate" as const, text: "x".repeat(6001) }];
    expect(interviewRequestSchema.safeParse({ ...valid, history: over }).success).toBe(false);
    const under = [{ speaker: "candidate" as const, text: "x".repeat(5999) }];
    expect(interviewRequestSchema.safeParse({ ...valid, history: under }).success).toBe(true);
  });

  it("accepts the technical round and an optional resume, stripping control chars", () => {
    expect(interviewRequestSchema.safeParse({ ...valid, roundType: "technical" }).success).toBe(true);
    const parsed = interviewRequestSchema.safeParse({ ...valid, resume: "line1bell\nline2" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.resume).toBe("line1bell\nline2");
    expect(interviewRequestSchema.safeParse({ ...valid, roundType: "gd" }).success).toBe(false);
  });

  it("requires a non-empty candidate name and caps it", () => {
    expect(interviewRequestSchema.safeParse({ ...valid, candidateName: "  " }).success).toBe(false);
    expect(interviewRequestSchema.safeParse({ ...valid, candidateName: "x".repeat(61) }).success).toBe(false);
  });

  it("accepts an optional resume profile and codeLanguage", () => {
    const profile = {
      name: "Rahul Verma",
      experienced: true,
      yearsOfExperience: 3,
      companies: ["Infosys"],
      skills: ["Java", "DSA"],
      projects: [{ name: "Payment Engine", summary: "Cut mismatches by 40%" }],
      education: "B.Tech",
      highlight: "Cut mismatches by 40%",
    };
    const parsed = interviewRequestSchema.safeParse({ ...valid, profile, codeLanguage: "java" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.profile?.experienced).toBe(true);
      expect(parsed.data.codeLanguage).toBe("java");
    }
  });

  it("rejects unknown code languages (enum, not free text)", () => {
    expect(interviewRequestSchema.safeParse({ ...valid, codeLanguage: "ruby" }).success).toBe(false);
  });

  it("requires the experienced flag inside a profile", () => {
    const profile = { companies: [], skills: [], projects: [] };
    expect(interviewRequestSchema.safeParse({ ...valid, profile }).success).toBe(false);
  });

  it("caps profile arrays: skills ≤12, companies ≤6, projects ≤4", () => {
    const base = { experienced: false, companies: [], skills: [], projects: [] };
    const skills = Array.from({ length: 13 }, (_, i) => `skill${i}`);
    expect(interviewRequestSchema.safeParse({ ...valid, profile: { ...base, skills } }).success).toBe(false);
    const companies = Array.from({ length: 7 }, (_, i) => `co${i}`);
    expect(interviewRequestSchema.safeParse({ ...valid, profile: { ...base, companies } }).success).toBe(false);
    const projects = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, summary: "s" }));
    expect(interviewRequestSchema.safeParse({ ...valid, profile: { ...base, projects } }).success).toBe(false);
  });

  it("caps profile string lengths: strings ≤200, project summaries ≤300", () => {
    const base = { experienced: false, companies: [], skills: [], projects: [] };
    expect(interviewRequestSchema.safeParse({ ...valid, profile: { ...base, name: "x".repeat(201) } }).success).toBe(false);
    const projects = [{ name: "p", summary: "x".repeat(301) }];
    expect(interviewRequestSchema.safeParse({ ...valid, profile: { ...base, projects } }).success).toBe(false);
    const okProjects = [{ name: "p", summary: "x".repeat(300) }];
    expect(interviewRequestSchema.safeParse({ ...valid, profile: { ...base, projects: okProjects } }).success).toBe(true);
  });
});
