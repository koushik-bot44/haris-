import { z } from "zod";

// Request validation for /api/interview — proxy hardening per the plan: strict
// shape, enums, turn and length caps. Lives outside the route file because
// Next.js route modules may only export handlers (and the tests import this).

export const RESUME_MAX_CHARS = 15_000;

/** Strip control characters (except newline/tab) from pasted resume text. */
export function sanitizeResume(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, RESUME_MAX_CHARS);
}

export const interviewRequestSchema = z.object({
  role: z.enum(["general", "java-sde-fresher", "frontend-fresher"]),
  roundType: z.enum(["hr", "technical"]),
  candidateName: z.string().trim().min(1).max(60),
  resume: z.string().max(RESUME_MAX_CHARS).transform(sanitizeResume).optional(),
  history: z
    .array(
      z.object({
        speaker: z.enum(["interviewer", "candidate"]),
        text: z.string().max(6000), // coding answers are longer than spoken ones
      }),
    )
    // Deep-dive rounds run to HARD_STOP_ANSWERS=16 answers ≈ 33+ entries.
    .max(48),
});
