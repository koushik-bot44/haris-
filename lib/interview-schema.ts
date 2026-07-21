import { z } from "zod";

// Request validation for /api/interview — proxy hardening per the plan: strict
// shape, enums, turn and length caps. Lives outside the route file because
// Next.js route modules may only export handlers (and the tests import this).

export const interviewRequestSchema = z.object({
  role: z.enum(["general", "java-sde-fresher", "frontend-fresher"]),
  roundType: z.literal("hr"),
  candidateName: z.string().trim().min(1).max(60),
  history: z
    .array(
      z.object({
        speaker: z.enum(["interviewer", "candidate"]),
        text: z.string().max(4000),
      }),
    )
    .max(30),
});
