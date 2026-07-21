import type { InterviewRequest, InterviewerTurn } from "@/lib/types";

// The provider abstraction the whole plan leans on. Weekend 1 ships the mock;
// `LLM_PROVIDER=gemini` + a key swaps in the real one later without touching
// callers. The fallback (Groq/OpenRouter) rides the same interface.
export interface LLMProvider {
  name: string;
  nextTurn(req: InterviewRequest): Promise<InterviewerTurn>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: "rate_limited" | "malformed" | "unavailable",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
