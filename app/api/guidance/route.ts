import { NextResponse } from "next/server";
import { z } from "zod";
import { RESUME_MAX_CHARS, sanitizeResume } from "@/lib/interview-schema";
import { buildGuidance } from "@/lib/llm/guidance";

// No session reads here — the client sends its derived performance summary
// (sessions live in the browser's localStorage, never on the server).

const bodySchema = z.object({
  role: z.enum(["general", "java-sde-fresher", "frontend-fresher"]),
  resumeText: z.string().max(RESUME_MAX_CHARS).transform(sanitizeResume).optional(),
  performance: z.object({
    avgScore: z.number().finite().min(0).max(5).nullable(),
    weakestCriterion: z.enum(["relevance", "structure", "depth", "communication"]).nullable(),
    sessionsCount: z.number().int().finite().min(0).max(100_000),
  }),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid shape" }, { status: 400 });
  }
  const { role, resumeText, performance } = parsed.data;
  const { guidance, source } = await buildGuidance({ role, resumeText, performance });
  return NextResponse.json({ guidance, source });
}
