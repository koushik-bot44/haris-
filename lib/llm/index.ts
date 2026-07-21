import type { LLMProvider } from "@/lib/llm/provider";
import { mockProvider } from "@/lib/llm/mock";
import { claudeCliProvider } from "@/lib/llm/claude-cli";

// Provider selection. `claude-cli` = the user's authenticated Claude Code CLI
// as the interviewer brain (dev-only, no API key, quickest model). When the
// Gemini key lands: LLM_PROVIDER=gemini + key in env → add lib/llm/gemini.ts
// here. Fallback (Groq/OpenRouter) joins the same map. Callers never change.
const providers: Record<string, LLMProvider> = {
  mock: mockProvider,
  "claude-cli": claudeCliProvider,
};

export function getProvider(): LLMProvider {
  const name = process.env.LLM_PROVIDER ?? "mock";
  return providers[name] ?? mockProvider;
}
