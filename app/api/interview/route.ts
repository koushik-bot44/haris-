import { NextResponse } from "next/server";
import { getProvider } from "@/lib/llm";
import { ProviderError } from "@/lib/llm/provider";
import { interviewRequestSchema } from "@/lib/interview-schema";
import type { InterviewRequest, InterviewerTurn } from "@/lib/types";

// The interviewer endpoint. Stateless: the client sends history, the provider
// decides the next turn. Hardening per the plan: strict shape validation, turn
// and length caps, enums — this route must not be usable as a general LLM
// proxy. (Upstash rate limiting + daily budget land in M1 weekend 2, before
// the public deploy — this route does not ship publicly without it.)

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = interviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request shape", details: parsed.error.issues.map((i) => i.message).slice(0, 3) },
      { status: 400 },
    );
  }

  const provider = getProvider();
  // req.signal threads to the claude-cli provider so a client abort/speculation
  // cancel kills the 30s CLI subprocess. Widened at the call site, not in the
  // LLMProvider interface: providers that take only the request ignore the
  // extra argument.
  const nextTurn = provider.nextTurn.bind(provider) as (
    r: InterviewRequest,
    signal?: AbortSignal,
  ) => Promise<InterviewerTurn>;

  // Provider failure policy from the error registry: retry once with the same
  // context, then degrade gracefully — the interview session never dies from a
  // single component failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const turn = await nextTurn(parsed.data, req.signal);
      return NextResponse.json({ turn, provider: provider.name });
    } catch (err) {
      if (attempt === 0) continue;
      const kind = err instanceof ProviderError ? err.kind : "unavailable";
      return NextResponse.json(
        { error: "interviewer_unavailable", kind, message: "The interviewer lost connection. You can continue to the next question." },
        { status: 503 },
      );
    }
  }
  // Unreachable, but TypeScript appreciates the certainty.
  return NextResponse.json({ error: "unreachable" }, { status: 500 });
}
