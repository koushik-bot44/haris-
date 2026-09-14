import type { LLMProvider } from "@/lib/llm/provider";
import { mockProvider } from "@/lib/llm/mock";
import { claudeCliProvider } from "@/lib/llm/claude-cli";
import { apiProvider } from "@/lib/llm/api-provider";
import { chatConfig } from "@/lib/llm/chat";

// Provider selection for the interviewer turn.
//   LLM_PROVIDER=mock        → scripted flow (CI, demos with no network)
//   LLM_PROVIDER=claude-cli  → the developer's authenticated Claude Code CLI
//   LLM_PROVIDER=groq|openai|gemini|openrouter|custom, or unset with a key
//                            → the cloud brain (lib/llm/api-provider.ts)
//   nothing configured       → mock, with a one-time console warning so a
//                              silent "why is it scripted?" never happens.

let warnedNoBrain = false;

export function getProvider(): LLMProvider {
  const name = process.env.LLM_PROVIDER;
  if (name === "mock") return mockProvider;
  if (name === "claude-cli") return claudeCliProvider;
  if (chatConfig()) return apiProvider;
  if (!warnedNoBrain) {
    warnedNoBrain = true;
    console.warn(
      "[llm] no LLM backend configured — the interviewer is running on the scripted question bank. " +
        "Set GROQ_API_KEY (free at https://console.groq.com), OPENAI_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY.",
    );
  }
  return mockProvider;
}
