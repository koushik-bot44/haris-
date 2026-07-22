import { describe, expect, it } from "vitest";
import { RESUME_MAX_CHARS } from "@/lib/interview-schema";
import { heuristicAnalysis, resumeAnalysisSchema } from "@/lib/llm/resume";
import {
  collapsePageText,
  extractPdfText,
  finalizeResumeText,
  MAX_PDF_BYTES,
  ResumeExtractError,
} from "@/lib/resume-extract";

const WEAK_RESUME = "I am a student looking for a job. I know some programming and want to learn more.";
const STRONG_RESUME = [
  "B.Tech CSE, NIT — CGPA 8.7. Skills: Java, SQL, Git, data structures and algorithms, JUnit testing.",
  "Projects: attendance tracker used by 200 students, cut manual entry time 40%. Deployed on AWS.",
  "Internship: backend intern at a startup, github.com/example — portfolio at example.dev.",
].join("\n");

describe("heuristicAnalysis (ATS fallback)", () => {
  it("produces the full schema shape for weak and strong resumes", () => {
    for (const r of [WEAK_RESUME, STRONG_RESUME]) {
      const parsed = resumeAnalysisSchema.safeParse(heuristicAnalysis(r));
      expect(parsed.success).toBe(true);
    }
  });

  it("keeps the score an integer in 0–100", () => {
    for (const r of ["", WEAK_RESUME, STRONG_RESUME, "project ".repeat(2000)]) {
      const { atsScore } = heuristicAnalysis(r);
      expect(Number.isInteger(atsScore)).toBe(true);
      expect(atsScore).toBeGreaterThanOrEqual(0);
      expect(atsScore).toBeLessThanOrEqual(100);
    }
  });

  it("is deterministic for the same input", () => {
    expect(heuristicAnalysis(STRONG_RESUME)).toEqual(heuristicAnalysis(STRONG_RESUME));
    expect(heuristicAnalysis(WEAK_RESUME)).toEqual(heuristicAnalysis(WEAK_RESUME));
  });

  it("scores a signal-rich resume above a thin one", () => {
    expect(heuristicAnalysis(STRONG_RESUME).atsScore).toBeGreaterThan(heuristicAnalysis(WEAK_RESUME).atsScore);
  });

  it("names missing skills and improvements for a thin resume, within caps", () => {
    const a = heuristicAnalysis(WEAK_RESUME);
    expect(a.missingSkills.length).toBeGreaterThanOrEqual(1);
    expect(a.missingSkills.length).toBeLessThanOrEqual(6);
    expect(a.improvements.length).toBeGreaterThanOrEqual(1);
    expect(a.improvements.length).toBeLessThanOrEqual(4);
  });

  it("always gives at least one improvement, even when every signal is present", () => {
    expect(heuristicAnalysis(STRONG_RESUME).improvements.length).toBeGreaterThanOrEqual(1);
  });
});

describe("resumeAnalysisSchema ATS bounds", () => {
  const base = heuristicAnalysis(STRONG_RESUME);

  it("rejects out-of-range and non-integer scores", () => {
    expect(resumeAnalysisSchema.safeParse({ ...base, atsScore: 101 }).success).toBe(false);
    expect(resumeAnalysisSchema.safeParse({ ...base, atsScore: -1 }).success).toBe(false);
    expect(resumeAnalysisSchema.safeParse({ ...base, atsScore: 61.5 }).success).toBe(false);
  });

  it("requires the ATS fields to be present", () => {
    const { atsScore: _a, missingSkills: _m, improvements: _i, ...withoutAts } = base;
    expect(resumeAnalysisSchema.safeParse(withoutAts).success).toBe(false);
  });

  it("caps list sizes and item lengths", () => {
    expect(resumeAnalysisSchema.safeParse({ ...base, missingSkills: Array(7).fill("x") }).success).toBe(false);
    expect(resumeAnalysisSchema.safeParse({ ...base, missingSkills: ["y".repeat(121)] }).success).toBe(false);
    expect(resumeAnalysisSchema.safeParse({ ...base, improvements: Array(5).fill("x") }).success).toBe(false);
  });
});

describe("PDF extraction helpers (pure parts — pdfjs itself is not under test)", () => {
  it("collapses page items into readable text, honoring EOL markers", () => {
    const text = collapsePageText([
      { str: "Sai" },
      { str: "Gogineni", hasEOL: true },
      { str: "Java", hasEOL: false },
      { str: "  SQL " },
    ]);
    expect(text).toBe("Sai Gogineni\nJava SQL");
  });

  it("joins pages with a blank line and trims to RESUME_MAX_CHARS", () => {
    expect(finalizeResumeText(["Page one text goes here, long enough.", "Page two text also goes here."])).toBe(
      "Page one text goes here, long enough.\n\nPage two text also goes here.",
    );
    expect(finalizeResumeText(["x".repeat(RESUME_MAX_CHARS + 500)]).length).toBe(RESUME_MAX_CHARS);
  });

  it("throws a typed no-text error for image-only PDFs (nothing extractable)", () => {
    for (const pages of [[], ["", "  "], ["tiny"]]) {
      try {
        finalizeResumeText(pages);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ResumeExtractError);
        expect((e as ResumeExtractError).code).toBe("no-text");
        expect((e as ResumeExtractError).message).toMatch(/paste/i);
      }
    }
  });

  it("rejects oversized files with a typed too-large error before touching pdfjs", async () => {
    const big = new File([new Uint8Array(MAX_PDF_BYTES + 1)], "big.pdf", { type: "application/pdf" });
    await expect(extractPdfText(big)).rejects.toMatchObject({ name: "ResumeExtractError", code: "too-large" });
  });

  it("caps uploads at 10MB", () => {
    expect(MAX_PDF_BYTES).toBe(10 * 1024 * 1024);
  });
});
