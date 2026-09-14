import type { InterviewRequest, InterviewerTurn } from "@/lib/types";
import { computeNextTurn } from "@/lib/llm/interview-flow";
import { ProviderError, type LLMProvider } from "@/lib/llm/provider";

// Mock provider — the scripted question bank behind a realistic-feeling
// delay. It is the zero-config brain AND the rescue every other provider
// falls back to, so it must never be the thing that breaks a session:
// simulated failures ("chaos") are OPT-IN via LLM_MOCK_CHAOS=1 for exercising
// the retry paths in development, never on by default.

let callCounter = 0;

const CHAOS_EVERY = 17; // ~6% of calls fail once; the route's single retry absorbs it

function chaosEnabled(): boolean {
  return process.env.LLM_MOCK_CHAOS === "1";
}

function simulatedLatencyMs(): number {
  // 250–650ms, varied by counter — no Math.random so replays are stable.
  return 250 + ((callCounter * 137) % 400);
}

export const mockProvider: LLMProvider = {
  name: "mock",
  async nextTurn(req: InterviewRequest): Promise<InterviewerTurn> {
    callCounter++;
    await new Promise((r) => setTimeout(r, simulatedLatencyMs()));
    if (chaosEnabled() && callCounter % CHAOS_EVERY === 0) {
      throw new ProviderError("simulated 429 (mock chaos)", "rate_limited");
    }
    const turn = computeNextTurn(req.candidateName, req.history, req.roundType, req.role, req.profile, req.codeLanguage);
    return { ...turn, scripted: true };
  },
};
