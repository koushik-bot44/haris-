import { NextResponse } from "next/server";
import { z } from "zod";
import { RESUME_MAX_CHARS, sanitizeResume } from "@/lib/interview-schema";
import { analyzeResume } from "@/lib/llm/resume";

const bodySchema = z.object({
  resume: z.string().min(80, "paste the actual resume text (at least a few lines)").max(RESUME_MAX_CHARS),
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
  const { analysis, analyzer } = await analyzeResume(sanitizeResume(parsed.data.resume));
  return NextResponse.json({ analysis, analyzer });
}
