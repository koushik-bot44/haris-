import { NextResponse } from "next/server";
import { chatConfig } from "@/lib/llm/chat";
import { cliAllowed } from "@/lib/llm/cli-runner";
import { cloudTtsEngines } from "@/lib/tts-engines";
import { deepgramLiveEnabled, sttProvider } from "@/lib/stt-server";
import { dbEnabled } from "@/lib/db";
import { authEnabled } from "@/lib/auth";
import { memoryEnabled } from "@/lib/memory";
import { checkEnv } from "@/lib/env-check";
import { APP_VERSION as version } from "@/lib/version";

// Operational snapshot — which brains, voices and services this deployment
// has. Names only, never keys. Poll it after a deploy to confirm the keys
// landed, and read `warnings` when the interviewer sounds scripted.

export const dynamic = "force-dynamic";

export async function GET() {
  const llm = chatConfig();
  const llmLabel = llm
    ? `${llm.backend}/${llm.model}`
    : process.env.LLM_PROVIDER === "claude-cli" && cliAllowed()
      ? "claude-cli"
      : "scripted";
  const report = checkEnv();
  return NextResponse.json(
    {
      ok: report.errors.length === 0,
      version,
      env: process.env.NODE_ENV,
      llm: { backend: llm?.backend ?? null, model: llm?.model ?? null, label: llmLabel },
      tts: {
        cloud: cloudTtsEngines(),
        chatterbox: Boolean(process.env.CHATTERBOX_URL) || process.env.NODE_ENV !== "production",
      },
      stt: { cloud: sttProvider(), deepgramLive: deepgramLiveEnabled() },
      db: dbEnabled(),
      rateLimit: Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ? "upstash" : "memory",
      auth: { jwtSecret: Boolean(process.env.AUTH_JWT_SECRET), google: authEnabled() },
      memory: memoryEnabled(),
      warnings: report.warnings,
      errors: report.errors,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
