import type { LLMProvider } from "@/lib/llm/provider";
import { mockProvider } from "@/lib/llm/mock";
import { claudeCliProvider } from "@/lib/llm/claude-cli";
import { groqEnabled, groqProvider } from "@/lib/llm/groq";

// Provider selection. `groq` = production brain (sub-second turns, streams).
// `claude-cli` = the user's authenticated Claude Code CLI (dev-only, no key).
// `mock` = scripted flow for CI and rescue. Unset LLM_PROVIDER picks the best
// available: groq when its key exists, else mock. Callers never change.
const providers: Record<string, LLMProvider> = {
  mock: mockProvider,
  "claude-cli": claudeCliProvider,
  groq: groqProvider,
};

export function getProvider(): LLMProvider {
  const name = process.env.LLM_PROVIDER;
  if (!name) return groqEnabled() ? groqProvider : mockProvider;
  return providers[name] ?? mockProvider;
}
