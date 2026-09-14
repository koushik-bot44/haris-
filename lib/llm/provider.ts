import type { ProposedMove, TurnKind } from "@/lib/interview/types";
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

export interface GenerateInput {
  req: InterviewRequest;
  kind: TurnKind;
  /** The interview state rendered for the model (lib/interview/brief.ts). */
  brief: string;
  objective: string;
  recall: string;
  /** Set on a retry after the proposed move was refused: the move to execute. */
  forcedMove?: ProposedMove | null;
  signal?: AbortSignal;
}

export interface GeneratedTurn {
  text: string;
  /** The move the model proposed, unvalidated — the orchestrator decides. */
  move: unknown | null;
  note: string | null;
  done: boolean;
}

/** A provider the adaptive engine can drive: the application plans the turn,
 * the model only writes it. generate() resolves null when no model is
 * available (the deterministic interviewer speaks) and throws on failure. */
export interface AdaptiveLLMProvider extends LLMProvider {
  adaptive: true;
  generate(input: GenerateInput): Promise<GeneratedTurn | null>;
}

export function isAdaptive(p: LLMProvider): p is AdaptiveLLMProvider {
  const a = p as Partial<AdaptiveLLMProvider>;
  return a.adaptive === true && typeof a.generate === "function";
}
