import type { LLMProvider } from "@/lib/llm/provider";
import { mockProvider } from "@/lib/llm/mock";

// Provider selection. Today: mock only. When the Gemini key lands:
//   LLM_PROVIDER=gemini + GEMINI_API_KEY in env → add lib/llm/gemini.ts here.
// Fallback (Groq/OpenRouter) joins the same map. Callers never change.
const providers: Record<string, LLMProvider> = {
  mock: mockProvider,
};

export function getProvider(): LLMProvider {
  const name = process.env.LLM_PROVIDER ?? "mock";
  return providers[name] ?? mockProvider;
}
