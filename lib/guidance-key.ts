// Client-safe on purpose: the guidance page imports this at runtime, and
// lib/llm/guidance.ts pulls the CLI runner (node:child_process) — which must
// never reach the client bundle. lib/llm/guidance.ts re-exports this.

/** djb2 over the first 4000 chars — a short, stable fingerprint so pasting or
 * editing a resume invalidates the cached guidance. Pure. */
export function shortHash(text: string): string {
  const s = text.slice(0, 4000);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Cache key for the client-side guidance cache. Composite over every input
 * that shapes the guidance (role presets and criteria never contain ":"). */
export function guidanceCacheKey(
  role: string,
  sessionsCount: number,
  avgScore: number | null,
  weakestCriterion: string | null,
  resumeText: string | undefined,
): string {
  const resumePart = resumeText ? shortHash(resumeText) : "none";
  return `${role}:${sessionsCount}:${avgScore ?? "none"}:${weakestCriterion ?? "none"}:${resumePart}`;
}
