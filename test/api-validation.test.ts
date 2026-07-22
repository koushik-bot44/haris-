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
    const history = Array.from({ length: 31 }, () => ({ speaker: "candidate" as const, text: "x" }));
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
});
