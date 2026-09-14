// Production configuration guard — pure, testable. Called once at server
// start (instrumentation.ts) so a misconfigured deploy fails LOUDLY at boot
// instead of quietly running with a forgeable session secret or a scripted
// "AI". Warnings describe degraded-but-working states; errors are fatal in
// production only.

export interface EnvReport {
  errors: string[];
  warnings: string[];
}

const MIN_SECRET_LEN = 32;

export function checkEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prod = env.NODE_ENV === "production";
  const has = (k: string) => Boolean(env[k] && env[k]!.trim());

  if (prod) {
    if (!has("AUTH_JWT_SECRET")) {
      errors.push(
        "AUTH_JWT_SECRET is not set. Every session token would be signed with the public dev secret and be forgeable. " +
          "Generate one with `openssl rand -hex 32` and set it in the environment.",
      );
    } else if (env.AUTH_JWT_SECRET!.trim().length < MIN_SECRET_LEN) {
      errors.push(`AUTH_JWT_SECRET is too short (${env.AUTH_JWT_SECRET!.trim().length} chars) — use at least ${MIN_SECRET_LEN}.`);
    }
    if (!has("MONGODB_URI")) {
      warnings.push("MONGODB_URI is not set — accounts and server-side history are disabled (guest mode only).");
    }
    if (!(has("UPSTASH_REDIS_REST_URL") && has("UPSTASH_REDIS_REST_TOKEN"))) {
      warnings.push("UPSTASH_REDIS_* not set — rate limits are per-instance only (fine for a single server, weak on serverless).");
    }
  }

  const llmKeys = ["GROQ_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "LLM_API_KEY"];
  if (!llmKeys.some(has) && env.LLM_PROVIDER !== "claude-cli") {
    warnings.push(
      "No LLM key set (GROQ_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY) — the interviewer runs on the scripted question bank.",
    );
  }
  const ttsKeys = ["ELEVENLABS_API_KEY", "OPENAI_API_KEY", "DEEPGRAM_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
  if (!ttsKeys.some(has) && !has("CHATTERBOX_URL")) {
    warnings.push("No voice key set — the interviewer speaks with the on-device/system voice.");
  }
  if (env.LLM_PROVIDER && !["mock", "claude-cli", "groq", "openai", "gemini", "openrouter", "custom"].includes(env.LLM_PROVIDER)) {
    warnings.push(`LLM_PROVIDER=${env.LLM_PROVIDER} is not a known provider — falling back to auto-detection.`);
  }
  if (prod && env.LLM_PROVIDER === "claude-cli") {
    warnings.push("LLM_PROVIDER=claude-cli is development-only; production will use the scripted interviewer.");
  }
  return { errors, warnings };
}

/** Log the report; throw in production when there are errors. */
export function assertEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const report = checkEnv(env);
  for (const w of report.warnings) console.warn(`[env] ${w}`);
  for (const e of report.errors) console.error(`[env] FATAL: ${e}`);
  if (report.errors.length && env.NODE_ENV === "production") {
    throw new Error(`Refusing to start in production: ${report.errors.length} configuration error(s) — see the log above.`);
  }
  return report;
}
