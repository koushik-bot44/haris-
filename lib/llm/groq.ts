import type { InterviewerTurn, InterviewRequest } from "@/lib/types";
import type { LLMProvider } from "@/lib/llm/provider";
import { buildPrompt, type NextTurnOpts } from "@/lib/llm/claude-cli";
import { clampTurn, deriveProgress, parseStreamedTurn } from "@/lib/llm/parse";
import { computeNextTurn, CODING_QUESTION_SLOT, QUESTIONS_PER_INTERVIEW } from "@/lib/llm/interview-flow";
import { CODING_INTRO, codingQuestionFor, codingSeedFrom } from "@/lib/fixtures/technical-questions";
import { CODING_AFTER_ANSWERS } from "@/lib/llm/interview-stages";

// Groq production provider — sub-second interviewer turns (measured: 0.7s
// llama-3.3-70b full reply, 0.24s 8b-instant). Same prompt, same streamed
// @@CTRL protocol, same deterministic scaffolding and scripted rescue as the
// dev CLI provider — only the transport differs. Unlike claude-cli this is
// PRODUCTION-SAFE: a deployed server uses it whenever GROQ_API_KEY is set.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TURN_TIMEOUT_MS = 12_000;
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
/** Tried once when the main model is rate-limited. A smaller model still holds
 * a real conversation; the fixture bank does not, and dropping to canned
 * questions mid-interview is exactly what makes this feel like a form. Free-tier
 * Groq meters tokens per minute per model, so the small model usually still has
 * headroom when the big one has none. */
const RATE_LIMIT_FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || "llama-3.1-8b-instant";

/** Set once the fallback model turns out to be blocked for this org, so we stop
 * paying a doomed round trip on every rate-limited turn. Process-lifetime. */
let fallbackUnavailable = false;

export function groqEnabled(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

function groqModel(): string {
  return process.env.GROQ_MODEL || DEFAULT_MODEL;
}

/** One-shot or streaming chat completion. onDelta receives raw text deltas as
 * they arrive; the resolved value is always the full completion text. Used by
 * the interviewer turns here and by scoring/resume/guidance/GD as the
 * production path their heuristics rescue. */
export async function groqComplete(
  prompt: string,
  opts?: { model?: string; maxTokens?: number; signal?: AbortSignal; onDelta?: (delta: string) => void },
): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("groq_disabled");
  const timeout = AbortSignal.timeout(TURN_TIMEOUT_MS);
  const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const stream = Boolean(opts?.onDelta);
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: opts?.model ?? groqModel(),
      messages: [{ role: "user", content: prompt }],
      max_tokens: opts?.maxTokens ?? 400,
      stream,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`groq_${res.status}`);
  if (!stream || !res.body) {
    const d = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return d.choices?.[0]?.message?.content ?? "";
  }
  // OpenAI-style SSE: `data: {json}` lines, terminated by `data: [DONE]`.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data: ") ? line.slice(6).trim() : null;
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          opts?.onDelta?.(delta);
        }
      } catch {
        // partial/noise line — ignore
      }
    }
    if (done) break;
  }
  return full;
}

/** Shared with the client so the spoken problem and the editor's starter can
 * never disagree — see codingSeedFrom. */
function codingSeed(req: InterviewRequest): string {
  return codingSeedFrom(req.candidateName, req.history);
}

/** The lead-in used to be one fixed sentence, so the hand-off to the editor
 * sounded identical in every interview. Same information, varied phrasing. */
const CODING_LEAD_INS = [
  CODING_INTRO,
  "Let's switch gears and get you writing something. The editor is open — talk me through your thinking in comments if you like, and submit when you're happy with it.",
  "Good — now let's see some code. Use the editor, comment as much or as little as you want, and submit when ready.",
];

function codingLeadIn(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return CODING_LEAD_INS[h % CODING_LEAD_INS.length];
}

/** Topic carry when the control line was missing: ~3 answers per topic. */
function carryQuestionIndex(turn: InterviewerTurn, answers: number): InterviewerTurn {
  // A turn that asked nothing belongs to no topic. Without this, answering
  // "what's your name?" gets stamped with a topic number and the progress
  // display advances as though an interview question had just been asked.
  if (turn.type === "reply" && !turn.asked) return turn;
  if (turn.questionIndex > 0 || turn.type === "greeting" || turn.type === "wrapup") return turn;
  const idx = Math.min(QUESTIONS_PER_INTERVIEW, Math.max(1, Math.ceil(answers / 3)));
  return { ...turn, questionIndex: idx };
}

export const groqProvider = {
  name: "groq",
  async nextTurn(req: InterviewRequest, opts?: NextTurnOpts): Promise<InterviewerTurn> {
    const o: NextTurnOpts = opts instanceof AbortSignal ? { signal: opts } : (opts ?? {});
    // The rescue path. It used to be completely silent, which meant a broken
    // key, a decommissioned model or an unparseable reply all looked exactly
    // like "the AI is scripted" — with no way to tell from the outside. Every
    // fall back now says why, on the server console.
    const scripted = (why: string): InterviewerTurn => {
      console.warn(`[interview] scripted fallback — ${why}`);
      const turn = computeNextTurn(req.candidateName, req.history, req.roundType, req.role, req.profile, req.codeLanguage);
      o.onText?.(turn.text);
      return { ...turn, scripted: true };
    };
    // Deterministic turns stay in code (same policy as the CLI provider):
    // the greeting opens instantly, the coding slot is fixture-reliable.
    if (!groqEnabled()) return scripted("no GROQ_API_KEY in the server environment");
    if (req.history.length === 0) return scripted("opening turn is deterministic by design");
    // The coding exercise is still chosen in code — the editor needs a known
    // problem and starter, and a model inventing one would break scoring. What
    // changed is WHEN and WHICH:
    //   * it used to fire at exactly 2 answers, which lands about ninety
    //     seconds in and reads as the interview giving up on talking to you;
    //     now the conversation gets a real run first (CODING_AFTER_ANSWERS)
    //   * it used to be one fixed problem per role forever; now it is drawn
    //     from a pool, seeded so a session is stable but sessions differ
    if (req.roundType === "technical") {
      const { answers } = deriveProgress(req.history);
      if (answers >= CODING_AFTER_ANSWERS) {
        const codingQ = codingQuestionFor(req.role, req.codeLanguage, codingSeed(req));
        const alreadyAsked = req.history.some((h) => h.speaker === "interviewer" && h.text.includes(codingQ.text));
        if (!alreadyAsked) {
          const turn: InterviewerTurn = {
            type: "question",
            text: `${codingLeadIn(codingSeed(req))} ${codingQ.text}`,
            questionIndex: CODING_QUESTION_SLOT,
            done: false,
            asked: true,
            coding: true,
          };
          o.onText?.(turn.text);
          return turn;
        }
      }
    }
    try {
      // Same streamed @@CTRL protocol as the CLI: accumulate deltas, re-emit
      // the visible spoken text (control line + partial tail withheld).
      let buffer = "";
      let lastEmitted = "";
      const emit = o.onText
        ? (t: string) => {
            if (t && t !== lastEmitted) {
              lastEmitted = t;
              o.onText!(t);
            }
          }
        : undefined;
      const prompt = buildPrompt(req);
      const onDelta = emit
        ? (delta: string) => {
            buffer += delta;
            emit(visibleOf(buffer));
          }
        : undefined;
      // An interviewer turn is 1-3 spoken sentences plus a short control line.
      // The shared default of 400 let the model ramble, which cost latency on
      // every turn and burned the tokens-per-minute budget that decides whether
      // the next turn is answered by the model or by the fixture bank.
      const maxTokens = 220;
      let raw: string;
      try {
        raw = await groqComplete(prompt, { signal: o.signal, onDelta, maxTokens });
      } catch (err) {
        // Rate limited on the main model: drop to the small one rather than to
        // canned questions. Any other failure propagates to the outer catch.
        if (!(err instanceof Error) || !err.message.includes("429")) throw err;
        // The fallback is only useful if the org actually allows that model.
        // Observed in the wild: the main model enabled, the small one still
        // blocked — so every rate-limited turn paid a second round trip just to
        // be refused, then landed on canned questions anyway. Ask once, then
        // remember, and let the caller fail straight through to the rescue.
        if (fallbackUnavailable) throw err;
        console.warn("[interview] main model rate-limited, retrying on", RATE_LIMIT_FALLBACK_MODEL);
        buffer = "";
        lastEmitted = "";
        try {
          raw = await groqComplete(prompt, {
            signal: o.signal,
            onDelta,
            maxTokens,
            model: RATE_LIMIT_FALLBACK_MODEL,
          });
        } catch (fallbackErr) {
          if (fallbackErr instanceof Error && /_40[13]$/.test(fallbackErr.message)) {
            fallbackUnavailable = true;
            console.warn(
              `[interview] ${RATE_LIMIT_FALLBACK_MODEL} is not enabled on this Groq org — ` +
                `enable it at https://console.groq.com/settings/limits so rate-limited turns ` +
                `stay conversational instead of dropping to the fixture bank`,
            );
          }
          throw fallbackErr;
        }
      }
      const parsed = parseStreamedTurn(raw);
      if (parsed) {
        const progress = deriveProgress(req.history);
        const turn = clampTurn(carryQuestionIndex(parsed, progress.answers), progress);
        emit?.(turn.text);
        return turn;
      }
      return scripted("the model reply had no usable spoken text");
    } catch (err) {
      // network/429/timeout/bad model — the rescue keeps the interview alive
      return scripted(`groq call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
} satisfies LLMProvider;

// Local alias — keeps this module free of a parse.ts export-name dependency
// beyond what it already imports.
import { visibleStreamText } from "@/lib/llm/parse";
function visibleOf(buffer: string): string {
  return visibleStreamText(buffer);
}
