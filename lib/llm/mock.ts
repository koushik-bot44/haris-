import type { InterviewRequest, InterviewerTurn } from "@/lib/types";
import { computeNextTurn } from "@/lib/llm/interview-flow";
import { ProviderError, type LLMProvider } from "@/lib/llm/provider";

// Mock provider — the plan's mock-first mandate. It must feel like production:
// realistic latency, and occasional simulated failures so every rescue path in
// the error registry actually executes before a real key exists.
// Chaos is deterministic-ish (counter-based) so tests can rely on it; disable
// entirely with LLM_MOCK_CHAOS=0 (demo mode).

let callCounter = 0;

const CHAOS_EVERY = 17; // ~6% of calls fail once; the route's single retry absorbs it

function chaosEnabled(): boolean {
  return process.env.LLM_MOCK_CHAOS !== "0";
}

function simulatedLatencyMs(): number {
  // 800–1800ms, varied by counter — no Math.random so replays are stable.
  return 800 + ((callCounter * 137) % 1000);
}

export const mockProvider: LLMProvider = {
  name: "mock",
  async nextTurn(req: InterviewRequest): Promise<InterviewerTurn> {
    callCounter++;
    await new Promise((r) => setTimeout(r, simulatedLatencyMs()));
    if (chaosEnabled() && callCounter % CHAOS_EVERY === 0) {
      throw new ProviderError("simulated 429 (mock chaos)", "rate_limited");
    }
    return computeNextTurn(req.candidateName, req.history);
  },
};
