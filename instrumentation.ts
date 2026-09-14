// Runs once when the Next.js server starts (both `next dev` and `next start`).
// Validates the environment so a production deploy with a forgeable session
// secret refuses to boot, and logs which brains/voices are configured.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertEnv } = await import("@/lib/env-check");
  assertEnv();
}
