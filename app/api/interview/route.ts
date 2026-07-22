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
//
// Two response modes:
// - default: the original JSON { turn, provider } (speculation + fallback use it)
// - body.stream === true: text/event-stream of `data: {json}` frames — repeated
//   {kind:"text"} events with the ACCUMULATED spoken text, then one final
//   {kind:"turn"}; a provider failure emits {kind:"error"} and the client
//   retries once via the non-stream path.

/** Minimum gap between text frames — caption updates don't need more, and the
 * throttle keeps frame count (and client re-renders) bounded. */
const TEXT_EVENT_MIN_GAP_MS = 80;

type NextTurnFn = (
  r: InterviewRequest,
  opts?: { signal?: AbortSignal; onText?: (fullTextSoFar: string) => void },
) => Promise<InterviewerTurn>;

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
  const nextTurn = provider.nextTurn.bind(provider) as NextTurnFn;

  // `stream` rides outside the zod schema (which strips unknown keys) so the
  // validated request shape is identical in both modes.
  if ((body as { stream?: unknown }).stream === true) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // enqueue throws once the client is gone — swallow, the provider abort
        // (req.signal) is what actually stops the work.
        const send = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {}
        };
        let lastSentAt = 0;
        let pending: string | null = null;
        let trailing: ReturnType<typeof setTimeout> | null = null;
        const sendText = (text: string) => {
          lastSentAt = Date.now();
          pending = null;
          send({ kind: "text", text });
        };
        // Leading-edge send, trailing timer for chunks landing inside the gap —
        // the newest accumulated text always gets out within one gap.
        const onText = (fullTextSoFar: string) => {
          const wait = TEXT_EVENT_MIN_GAP_MS - (Date.now() - lastSentAt);
          if (wait <= 0) {
            sendText(fullTextSoFar);
            return;
          }
          pending = fullTextSoFar;
          if (!trailing) {
            trailing = setTimeout(() => {
              trailing = null;
              if (pending !== null) sendText(pending);
            }, wait);
          }
        };
        try {
          const turn = await nextTurn(parsed.data, { signal: req.signal, onText });
          if (trailing) clearTimeout(trailing);
          pending = null;
          send({ kind: "turn", turn, provider: provider.name });
        } catch (err) {
          // No in-stream retry: the client falls back to one non-stream POST
          // (which carries the retry-once policy) — the interview never dies.
          if (trailing) clearTimeout(trailing);
          const kind = err instanceof ProviderError ? err.kind : "unavailable";
          send({ kind: "error", error: "interviewer_unavailable", kind2: kind });
        } finally {
          try {
            controller.close();
          } catch {}
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  // Provider failure policy from the error registry: retry once with the same
  // context, then degrade gracefully — the interview session never dies from a
  // single component failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const turn = await nextTurn(parsed.data, { signal: req.signal });
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
