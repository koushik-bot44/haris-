import type { HistoryEntry } from "@/lib/types";

// Long-term candidate memory, backed by Supermemory (supermemory.ai).
//
// The transcript already gives the interviewer memory WITHIN a session, and it
// works — it recalls your name and your projects. What it cannot do is remember
// you between sessions, which is the whole point of practising repeatedly: the
// second interview should know you struggled with complexity in the first.
//
// Design rules, all of them learned the hard way in this codebase:
//
//   * Env-gated. No SUPERMEMORY_API_KEY means every function here is a no-op
//     and the interview behaves exactly as before. Same posture as Mongo and
//     Upstash in this app: zero env = it still runs.
//   * It can never break or slow an interview. Reads are cached per candidate
//     and time-boxed; writes are fire-and-forget. Every failure is swallowed
//     and logged, never thrown at the turn.
//   * Reads use v3/search, not v4/profile. Verified against the live API:
//     search scopes on `containerTags` (array) and returns the stored facts;
//     profile takes `containerTag` (string) and returned nothing for documents
//     added this way. Search is the path that demonstrably works.
//   * Writes are asynchronous server-side — a document comes back `queued` and
//     took ~20s to become searchable. So this is cross-SESSION memory. Never
//     write a fact and expect to read it back in the same interview.

const API = "https://api.supermemory.ai";
const SEARCH_TIMEOUT_MS = 1200;
const WRITE_TIMEOUT_MS = 4000;
/** Recall is cached this long per candidate, so a ~150ms search does not land
 * on the critical path of every single turn. */
const RECALL_TTL_MS = 10 * 60_000;
/** Shorter answers are chatter ("yes", "I think so") — not worth remembering. */
const MIN_MEMORABLE_CHARS = 40;
const MAX_RECALLED_FACTS = 5;

function apiKey(): string | null {
  return process.env.SUPERMEMORY_API_KEY || null;
}

export function memoryEnabled(): boolean {
  return Boolean(apiKey());
}

/** Namespaced so this app's memories never collide with anything else on the
 * same Supermemory account. */
export function containerTagFor(candidateName: string): string {
  const slug = candidateName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40);
  return `pds_candidate_${slug || "anon"}`;
}

const recallCache = new Map<string, { at: number; facts: string[] }>();

/** What we already know about this candidate from earlier sessions. Returns an
 * empty array whenever memory is off, cold, slow or broken — the caller must
 * not care which. */
export async function recallCandidate(candidateName: string, query: string): Promise<string[]> {
  const key = apiKey();
  if (!key) return [];
  const tag = containerTagFor(candidateName);
  const cached = recallCache.get(tag);
  if (cached && Date.now() - cached.at < RECALL_TTL_MS) return cached.facts;

  try {
    const res = await fetch(`${API}/v3/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ containerTags: [tag], q: query, limit: MAX_RECALLED_FACTS }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`supermemory_${res.status}`);
    const data = (await res.json()) as {
      results?: { score?: number; chunks?: { content?: string }[] }[];
    };
    const facts = (data.results ?? [])
      .flatMap((r) => (r.chunks ?? []).map((c) => c.content ?? ""))
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_RECALLED_FACTS);
    recallCache.set(tag, { at: Date.now(), facts });
    if (facts.length) console.info(`[memory] recalled ${facts.length} fact(s) for ${tag}`);
    return facts;
  } catch (err) {
    console.warn("[memory] recall failed, continuing without it:", err instanceof Error ? err.message : err);
    // Cache the miss briefly so a broken key does not retry on every turn.
    recallCache.set(tag, { at: Date.now(), facts: [] });
    return [];
  }
}

/** Store what the candidate said. Fire-and-forget: never awaited on the turn
 * path, never allowed to reject. */
export function rememberAnswer(candidateName: string, roundType: string, answer: string): void {
  const key = apiKey();
  if (!key) return;
  const text = answer.trim();
  if (text.length < MIN_MEMORABLE_CHARS) return;
  const tag = containerTagFor(candidateName);
  void fetch(`${API}/v3/documents`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      // Framed as a fact about the person, not a raw quote, so retrieval reads
      // as knowledge rather than as a stray line of transcript.
      content: `In a ${roundType} practice interview, ${candidateName} said: ${text}`,
      containerTags: [tag],
    }),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
    .then((r) => {
      if (!r.ok) console.warn(`[memory] write rejected: supermemory_${r.status}`);
    })
    .catch((err) => {
      console.warn("[memory] write failed:", err instanceof Error ? err.message : err);
    });
}

/** The newest candidate answer — what we store, and the search query when it is
 * substantial enough to be about something. */
export function latestAnswer(history: HistoryEntry[]): string {
  return [...history].reverse().find((h) => h.speaker === "candidate")?.text?.trim() ?? "";
}

/** What we hold this candidate's history against.
 *
 * Not simply the last thing they said: at the start of an interview that is
 * "hello, ready when you are", which matches nothing and made a candidate with
 * real stored history look like a stranger. Chatter falls back to a standing
 * query about the person, which is what we actually want to recall anyway. */
const STANDING_QUERY = "background, projects, skills, strengths, weaknesses, past interview performance";

export function recallQuery(history: HistoryEntry[]): string {
  const answer = latestAnswer(history);
  return answer.length >= MIN_MEMORABLE_CHARS ? `${STANDING_QUERY}. ${answer}` : STANDING_QUERY;
}

/** The prompt block. Empty string when there is nothing to say, so the prompt
 * does not carry a dangling empty heading. */
export function recallBlock(facts: string[]): string {
  if (!facts.length) return "";
  return [
    `FROM EARLIER SESSIONS WITH THIS CANDIDATE (background you already have — use it naturally,`,
    `never announce that you are recalling it, and never treat it as something they just said):`,
    ...facts.map((f) => `- ${f}`),
  ].join("\n");
}
