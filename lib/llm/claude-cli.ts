import { execFile } from "node:child_process";
import type { InterviewRequest, InterviewerTurn } from "@/lib/types";
import type { LLMProvider } from "@/lib/llm/provider";
import { computeNextTurn } from "@/lib/llm/interview-flow";
import { clampTurn, deriveProgress, parseInterviewerJson, transcriptFor } from "@/lib/llm/parse";

// Development-only provider: the user's authenticated Claude Code CLI is the
// brain — a genuinely adaptive interviewer with NO API key, on the fastest
// model (haiku). Local dev only: the CLI doesn't exist on a deployed server,
// and the provider refuses to run outside development. Production later swaps
// to Gemini via the same abstraction (the plan's mock-first → key-later path).
//
// Failure posture (error-registry rule — the interview never dies): any CLI
// failure, timeout, or unparseable reply falls back to the scripted flow for
// that turn. The route's `provider` field reports which brain actually spoke.

const TIMEOUT_MS = 30_000;

const ROLE_LABEL: Record<string, string> = {
  general: "a general fresher role",
  "java-sde-fresher": "a Java SDE fresher role",
  "frontend-fresher": "a frontend developer fresher role",
};

function buildPrompt(req: InterviewRequest): string {
  const { answers } = deriveProgress(req.history);
  const transcript = req.history.length ? transcriptFor(req.history) : "(nothing yet — open the interview)";
  return [
    `You are Priya Sharma, a warm but sharp HR interviewer at Meridian Corp, running a REAL campus-placement HR interview with ${req.candidateName} for ${ROLE_LABEL[req.role] ?? "a fresher role"}.`,
    `This is a live spoken conversation, not a script: first react in ONE short sentence to something SPECIFIC the candidate just said (skip this for the greeting), then ask exactly ONE thing. Maximum 2 sentences total. Plain spoken English — no lists, no emojis, nothing that cannot be read aloud.`,
    `Rules: exactly 5 main questions across the whole interview; at most one short follow-up per main question and only when the answer was thin or evasive; never repeat a question; after the 5th main question is properly answered, wrap up warmly in 2 sentences with done=true.`,
    `Answers given so far: ${answers}.`,
    ``,
    `Interview so far:`,
    transcript,
    ``,
    `Reply ONLY with minified JSON: {"type":"greeting|question|followup|wrapup","text":"...","questionIndex":N,"done":false}`,
    `questionIndex = which main question (1-5) this turn belongs to; 0 for greeting/wrapup.`,
  ].join("\n");
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      // --strict-mcp-config: without it the CLI boots every globally-configured
      // MCP server on each call — measured at +17s per interviewer turn.
      ["-p", "--model", "haiku", "--output-format", "text", "--strict-mcp-config"],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export const claudeCliProvider: LLMProvider = {
  name: "claude-cli",
  async nextTurn(req: InterviewRequest): Promise<InterviewerTurn> {
    if (process.env.NODE_ENV === "production") {
      // Never on a server — scripted flow keeps working instead.
      return computeNextTurn(req.candidateName, req.history);
    }
    try {
      const raw = await runClaude(buildPrompt(req));
      const parsed = parseInterviewerJson(raw);
      if (parsed) return clampTurn(parsed, deriveProgress(req.history));
    } catch {
      // fall through to the scripted rescue below
    }
    return computeNextTurn(req.candidateName, req.history);
  },
};
