import { NextResponse } from "next/server";
import { getProvider } from "@/lib/llm";
import { ProviderError } from "@/lib/llm/provider";
import { interviewRequestSchema } from "@/lib/interview-schema";
import { auth } from "@/lib/auth";
import { guestCookieHeader, memorySubjectFor, newGuestId, readGuestId } from "@/lib/memory";
import { chatConfig } from "@/lib/llm/chat";
import type { InterviewRequest, InterviewerTurn } from "@/lib/types";

/** A streamed turn must outlive the platform's default function timeout. */
export const maxDuration = 60;

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

/** Brains whose free tier cannot afford a speculative guess per turn. */
const METERED_BACKENDS = new Set(["groq"]);

/** LLM_SPECULATE=1 forces mid-answer speculation on, =0 forces it off;
 * otherwise it is on for every brain except the metered ones. */
function speculationAllowed(): boolean {
  const flag = process.env.LLM_SPECULATE?.trim();
  if (flag === "1") return true;
  if (flag === "0") return false;
  const backend = chatConfig()?.backend;
  return !backend || !METERED_BACKENDS.has(backend);
}

type NextTurnFn = (
  r: InterviewRequest,
  opts?: {
    signal?: AbortSignal;
    onText?: (fullTextSoFar: string) => void;
    memoryKey?: string | null;
    speculative?: boolean;
  },
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
  // Long-term memory is keyed by identity, never by the typed name — two
  // candidates called "Rahul" must never read each other's history.
  //
  // That identity used to be the signed-in user id ALONE, and this deployment
  // has no accounts (no MONGODB_URI), so it was null on every request and the
  // whole memory layer was skipped in production: the interviewer could not
  // avoid repeating a question because it was never told who it was talking to.
  // Guests now get a durable anonymous id of their own — opaque, per-browser,
  // minted here on first contact and good for a year. It rides in a cookie
  // rather than localStorage because the interview client belongs to another
  // workstream and this needs no change there.
  const { userId } = await auth();
  const sentGuestId = readGuestId(req.headers.get("cookie"));
  const guestId = sentGuestId ?? newGuestId();
  // `stream` / `speculative` ride outside the zod schema (which strips unknown
  // keys) so the validated request shape is identical in every mode.
  const speculative = (body as { speculative?: unknown }).speculative === true;
  const turnOpts = { memoryKey: memorySubjectFor(userId, guestId), speculative };
  // Only on the request that minted it — re-sending an unchanged cookie on
  // every turn of the interview is pure noise on the wire.
  const setCookie = sentGuestId === null ? guestCookieHeader(guestId) : null;

  // MID-ANSWER SPECULATION IS A TOKEN-BUDGET DECISION, made here on the server
  // because only the server knows which brain is paying.
  //
  // The client pre-fetches a guess at the next turn while the candidate is
  // still talking, so an accepted guess starts speaking instantly. Every guess
  // is a full interviewer prompt (~2,000-2,700 tokens, measured), and most are
  // thrown away — so on a metered brain it roughly DOUBLES the spend per turn.
  // On Groq's free tier that is decisive: 8,000 tokens per minute per model,
  // and the live log showed the main model rate-limited on 3 of 5 calls in one
  // short session, each time dropping the candidate to a smaller model or the
  // fixture bank. A guess that costs the real turn its brain is not worth ~700
  // ms. The OPENING pre-fetch (empty history) is different: one request during
  // the mic check, hidden latency, and it must stay.
  //
  // The client already treats { turn: null } as "no speculation available".
  if (speculative && parsed.data.history.length > 0 && !speculationAllowed()) {
    const res = NextResponse.json({ turn: null, provider: provider.name, skipped: "metered_backend" });
    if (setCookie) res.headers.append("set-cookie", setCookie);
    return res;
  }

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
          const turn = await nextTurn(parsed.data, { signal: req.signal, onText, ...turnOpts });
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
        ...(setCookie ? { "set-cookie": setCookie } : {}),
      },
    });
  }

  // Provider failure policy from the error registry: retry once with the same
  // context, then degrade gracefully — the interview session never dies from a
  // single component failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const turn = await nextTurn(parsed.data, { signal: req.signal, ...turnOpts });
      const res = NextResponse.json({ turn, provider: provider.name });
      // append, not set: the rate-limit middleware may already have put its own
      // Set-Cookie on this response.
      if (setCookie) res.headers.append("set-cookie", setCookie);
      return res;
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
