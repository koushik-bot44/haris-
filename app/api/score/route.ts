import { NextResponse } from "next/server";
import { z } from "zod";
import { scoreAnswer, TOO_SHORT } from "@/lib/llm/score";

// Per-answer scoring endpoint — called in the background while the interview
// continues, so the scorecard is warm at wrap-up (plan: score one answer per
// call, never the batch transcript).

const bodySchema = z.object({
  // Deep-dive rounds push question ids past 8; the hook clamps at 20 too.
  questionId: z.number().int().min(1).max(20),
  question: z.string().min(1).max(1200),
  answer: z.string().min(1).max(8000),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid shape" }, { status: 400 });

  const result = await scoreAnswer(parsed.data.questionId, parsed.data.question, parsed.data.answer);
  if (result === TOO_SHORT) {
    return NextResponse.json({ tooShort: true });
  }
  return NextResponse.json({ entry: result.entry, scorer: result.scorer });
}
