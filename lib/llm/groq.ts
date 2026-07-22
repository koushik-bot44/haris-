import type { InterviewerTurn, InterviewRequest } from "@/lib/types";
import type { LLMProvider } from "@/lib/llm/provider";
import { buildPrompt, type NextTurnOpts } from "@/lib/llm/claude-cli";
import { clampTurn, deriveProgress, parseStreamedTurn } from "@/lib/llm/parse";
import { computeNextTurn, CODING_QUESTION_SLOT, QUESTIONS_PER_INTERVIEW } from "@/lib/llm/interview-flow";
import { CODING_INTRO, codingQuestionFor } from "@/lib/fixtures/technical-questions";

// Groq production provider — sub-second interviewer turns (measured: 0.7s
// llama-3.3-70b full reply, 0.24s 8b-instant). Same prompt, same streamed
// @@CTRL protocol, same deterministic scaffolding and scripted rescue as the
// dev CLI provider — only the transport differs. Unlike claude-cli this is
// PRODUCTION-SAFE: a deployed server uses it whenever GROQ_API_KEY is set.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TURN_TIMEOUT_MS = 12_000;
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

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

/** Topic carry when the control line was missing: ~3 answers per topic. */
function carryQuestionIndex(turn: InterviewerTurn, answers: number): InterviewerTurn {
  if (turn.questionIndex > 0 || turn.type === "greeting" || turn.type === "wrapup") return turn;
  const idx = Math.min(QUESTIONS_PER_INTERVIEW, Math.max(1, Math.ceil(answers / 3)));
  return { ...turn, questionIndex: idx };
}

export const groqProvider = {
  name: "groq",
  async nextTurn(req: InterviewRequest, opts?: NextTurnOpts): Promise<InterviewerTurn> {
    const o: NextTurnOpts = opts instanceof AbortSignal ? { signal: opts } : (opts ?? {});
    const scripted = (): InterviewerTurn => {
      const turn = computeNextTurn(req.candidateName, req.history, req.roundType, req.role, req.profile, req.codeLanguage);
      o.onText?.(turn.text);
      return turn;
    };
    // Deterministic turns stay in code (same policy as the CLI provider):
    // the greeting opens instantly, the coding slot is fixture-reliable.
    if (!groqEnabled() || req.history.length === 0) return scripted();
    if (req.roundType === "technical") {
      const { answers } = deriveProgress(req.history);
      if (answers === CODING_QUESTION_SLOT - 1) {
        const codingQ = codingQuestionFor(req.role, req.codeLanguage);
        const alreadyAsked = req.history.some((h) => h.speaker === "interviewer" && h.text.includes(codingQ.text));
        if (!alreadyAsked) {
          const turn: InterviewerTurn = {
            type: "question",
            text: `${CODING_INTRO} ${codingQ.text}`,
            questionIndex: CODING_QUESTION_SLOT,
            done: false,
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
      const raw = await groqComplete(buildPrompt(req), {
        signal: o.signal,
        onDelta: emit
          ? (delta) => {
              buffer += delta;
              emit(visibleOf(buffer));
            }
          : undefined,
      });
      const parsed = parseStreamedTurn(raw);
      if (parsed) {
        const progress = deriveProgress(req.history);
        const turn = clampTurn(carryQuestionIndex(parsed, progress.answers), progress);
        emit?.(turn.text);
        return turn;
      }
    } catch {
      // network/429/timeout — the scripted rescue keeps the interview alive
    }
    return scripted();
  },
} satisfies LLMProvider;

// Local alias — keeps this module free of a parse.ts export-name dependency
// beyond what it already imports.
import { visibleStreamText } from "@/lib/llm/parse";
function visibleOf(buffer: string): string {
  return visibleStreamText(buffer);
}
