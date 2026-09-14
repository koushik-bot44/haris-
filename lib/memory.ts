import type { HistoryEntry } from "@/lib/types";
import { createHash } from "node:crypto";
import { looksLikeCandidateQuestion } from "@/lib/llm/parse";

// Long-term candidate memory, backed by Supermemory (supermemory.ai).
//
// The transcript already gives the interviewer memory WITHIN a session, and it
// works — it recalls your name and your projects. What it cannot do is remember
// you between sessions, which is the whole point of practising repeatedly: the
// second interview should know you struggled with complexity in the first, and
// must not open on the question you already answered last week.
//
// Design rules, all of them learned the hard way in this codebase:
//
//   * Env-gated. No SUPERMEMORY_API_KEY means every function here is a no-op
//     and the interview behaves exactly as before. Same posture as Mongo and
//     Upstash in this app: zero env = it still runs.
//   * It can never break or slow an interview. Nothing here is awaited on a
//     turn: reads are primed at session start and afterwards served from cache
//     (peek*), writes are fire-and-forget. Every failure is swallowed and
//     logged, never thrown at the turn.
//   * Reads use v3/search, not v4/profile. Verified against the live API:
//     search scopes on `containerTags` (array) and returns the stored facts;
//     profile takes `containerTag` (string) and returned nothing for documents
//     added this way. Search is the path that demonstrably works.
//   * containerTags is an OR, not an AND. Verified live: a search carrying two
//     tags returns the documents of both. That is what lets one round trip
//     cover the current tag AND the orphaned legacy one.
//   * Writes are asynchronous server-side — a document comes back `queued` and
//     took ~20s to become searchable. So this is cross-SESSION memory. Never
//     write a fact and expect to read it back in the same interview; anything
//     this session needs to know about itself is tracked in-process instead.

const API = "https://api.supermemory.ai";
/** Generous because NOTHING waits on it any more (see primeCandidateMemory) —
 * the old 1200ms box existed to bound a search sitting on the turn's critical
 * path, and a cold search that times out is a session with no memory at all. */
const SEARCH_TIMEOUT_MS = 2500;
/** Writes are fire-and-forget, so a long box costs the turn nothing — and the
 * old 4000ms one was too short in practice: with eight interviews running at
 * once the live log showed "answer write failed … aborted due to timeout"
 * three times in ten turns, each a fact or an asked question silently lost. */
const WRITE_TIMEOUT_MS = 10_000;
/** A FAILED recall is cached only this long. It used to sit for the full
 * RECALL_TTL_MS, so one transient timeout at session start meant no long-term
 * memory for ten minutes — the whole round. */
const MISS_TTL_MS = 30_000;
/** Recall is cached this long per candidate. Long enough to cover a whole
 * round, short enough that a second round in the same sitting re-reads and
 * sees the questions the first round wrote. */
const RECALL_TTL_MS = 10 * 60_000;
/** Shorter answers are chatter ("yes", "I think so") — not worth remembering. */
const MIN_MEMORABLE_CHARS = 40;
const MAX_RECALLED_FACTS = 5;
/** A candidate who practises weekly accumulates questions fast; the whole point
 * is to know all of them, so this is deliberately larger than the fact cap. */
const MAX_RECALLED_QUESTIONS = 25;
/** How many already-asked questions actually reach the prompt. All 25 would be
 * a wall of text competing with the transcript for the model's attention. */
const MAX_ASKED_IN_PROMPT = 12;
const MAX_QUESTION_CHARS = 220;
/** Below this a "question" is a tic — "Really?", "Right?" — not something a
 * later session has to avoid. */
const MIN_QUESTION_CHARS = 12;

function apiKey(): string | null {
  return process.env.SUPERMEMORY_API_KEY || null;
}

export function memoryEnabled(): boolean {
  return Boolean(apiKey());
}

// ——— who the memory belongs to ———
//
// This is the defect that made everything else here dead code: recall and
// remember were gated on the signed-in user id, and this deployment has no
// accounts (no MONGODB_URI), so the id was null for every request and memory
// never ran once in production.
//
// Guests therefore get an identity of their own: an opaque random id in a
// first-party cookie, minted by the interview route on the first request and
// good for a year. A cookie rather than localStorage because it rides every
// request automatically — the interview client belongs to another workstream
// and needs no change — and because the value never has to be readable by JS.

export const GUEST_COOKIE = "pds_guest";
export const GUEST_COOKIE_MAX_AGE = 31_536_000; // 1y, same as the rate-limit cookie

/** The prefix is load-bearing, not decoration: it is what guarantees a guest id
 * can never collide with a real user id and read someone else's history. */
const GUEST_PREFIX = "guest-";
/** Any client can send arbitrary cookie bytes, and this value becomes part of a
 * container tag — validate before it is ever used as a storage key. */
const VALID_GUEST_ID = /^guest-[A-Za-z0-9-]{8,64}$/;

export function newGuestId(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${GUEST_PREFIX}${uuid}`;
}

/** The guest id a request carries, or null when it has none / sent junk. */
export function readGuestId(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== GUEST_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return VALID_GUEST_ID.test(value) ? value : null;
  }
  return null;
}

/** Mirrors lib/auth.ts secureFlag(). Duplicated rather than imported because
 * that module pulls NextAuth in, and this one must stay importable anywhere —
 * but the BEHAVIOUR has to match, or a LAN deployment over plain HTTP would
 * silently drop this cookie and every visit would look like a new guest. */
function secureCookies(): boolean {
  const override = process.env.AUTH_COOKIE_SECURE;
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  return process.env.NODE_ENV === "production";
}

export function guestCookieHeader(id: string, secure = secureCookies()): string {
  return [
    `${GUEST_COOKIE}=${id}`,
    "Path=/",
    `Max-Age=${GUEST_COOKIE_MAX_AGE}`,
    "SameSite=Lax",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** The subject every tag below is derived from: the signed-in user when there
 * is one, otherwise this browser's guest id. Signed-in ids are Mongo hex or
 * "google:<sub>" and guest ids always start "guest-", so the two namespaces
 * cannot overlap. */
export function memorySubjectFor(userId: string | null | undefined, guestId: string): string {
  return userId?.trim() || guestId;
}

// ——— container tags ———

function slug(subject: string): string {
  return subject.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60);
}

/** Memory is keyed by IDENTITY — the signed-in user id, or this browser's guest
 * id — never by the typed name: two candidates called "Rahul" must never read
 * each other's history. The id is hashed into the tag, so the memory provider
 * never sees a raw user id, and ids that differ only in case or punctuation can
 * no longer collapse into one bucket the way a slug let them. */
export function containerTagFor(subject: string): string {
  return `pds_u_${createHash("sha256").update(`pds-memory:${subject.trim()}`).digest("hex").slice(0, 32)}`;
}

/** The identity tag written before hashing (`pds_user_<slug of the id>`). Still
 * keyed on the id, never the name, so reading it keeps a returning candidate's
 * history reachable without letting anyone else's in. Read-only. */
export function previousContainerTagFor(subject: string): string | null {
  const s = slug(subject);
  return s ? `pds_user_${s}` : null;
}

/** Asked questions live under their OWN tag, per round type. Two reasons: a
 * search for "what do I know about this person" must not come back full of
 * questions, and a search for "what have I already asked" must not have to
 * out-rank the answers. An HR question is also fair game in a technical round
 * and vice versa, so the round type is part of the key. */
export function askedTagFor(subject: string, roundType: string): string {
  return `${containerTagFor(subject)}__asked_${slug(roundType) || "round"}`;
}

function previousAskedTagFor(subject: string, roundType: string): string | null {
  const prev = previousContainerTagFor(subject);
  return prev ? `${prev}__asked_${slug(roundType) || "round"}` : null;
}

// ——— cache ———
//
// One cache for both kinds of recall: same shape (string[]), same TTL, same
// reason for existing. `inFlight` is what makes priming idempotent — the
// greeting turn and its speculative twin both call it, and neither should
// produce a second HTTP request.

interface CacheEntry {
  at: number;
  value: string[];
  /** Per-entry lifetime; a miss lives far shorter than a hit. */
  ttl: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string[]>>();
/** A long-lived server sees one entry per guest browser. Nothing here is worth
 * a real LRU; Map preserves insertion order, so dropping the front is enough. */
const MAX_CACHE_ENTRIES = 500;

function cacheGet(key: string): string[] | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at >= hit.ttl) return null;
  return hit.value;
}

function cacheSet(key: string, value: string[], ttl: number = RECALL_TTL_MS): void {
  if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), value, ttl });
}

/** One search, fully swallowed. Returns the chunk texts, newest-ranked first. */
async function search(tags: string[], q: string, limit: number): Promise<string[]> {
  const key = apiKey();
  if (!key) return [];
  const res = await fetch(`${API}/v3/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ containerTags: tags, q, limit }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`supermemory_${res.status}`);
  const data = (await res.json()) as {
    results?: { score?: number; chunks?: { content?: string }[] }[];
  };
  return (data.results ?? [])
    .flatMap((r) => (r.chunks ?? []).map((c) => c.content ?? ""))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Search once per cache key, however many callers ask at once, and never
 * reject: a broken key, a timeout and an empty store all look like "nothing
 * known" to the caller, which is the only sane contract for a turn path. */
function searchCached(cacheKey: string, tags: string[], q: string, limit: number, label: string): Promise<string[]> {
  const cached = cacheGet(cacheKey);
  if (cached) return Promise.resolve(cached);
  const running = inFlight.get(cacheKey);
  if (running) return running;
  const p = search(tags, q, limit)
    .then((chunks) => {
      const value = chunks.slice(0, limit);
      cacheSet(cacheKey, value);
      if (value.length) console.info(`[memory] recalled ${value.length} ${label} for ${tags[0]}`);
      return value;
    })
    .catch((err) => {
      console.warn(`[memory] ${label} recall failed, continuing without it:`, err instanceof Error ? err.message : err);
      // Cache the miss BRIEFLY: a broken key must not retry on every turn, but a
      // transient timeout must not cost the round its memory either.
      cacheSet(cacheKey, [], MISS_TTL_MS);
      return [];
    })
    .finally(() => {
      inFlight.delete(cacheKey);
    });
  inFlight.set(cacheKey, p);
  return p;
}

// ——— recalling what we know about the candidate ———

/** Identity tags only. The old name-keyed `pds_candidate_<name>` tag is never
 * read: it is shared by everyone with the same name. */
function factTags(subject: string): string[] {
  const prev = previousContainerTagFor(subject);
  return prev ? [containerTagFor(subject), prev] : [containerTagFor(subject)];
}

/** What we already know about this candidate from earlier sessions. Returns an
 * empty array whenever memory is off, cold, slow or broken — the caller must
 * not care which. */
export async function recallCandidate(
  subject: string,
  query: string,
  opts: { candidateName?: string } = {},
): Promise<string[]> {
  if (!apiKey() || !subject.trim()) return [];
  void opts.candidateName;
  const tags = factTags(subject);
  return searchCached(`facts:${tags.join("+")}`, tags, query, MAX_RECALLED_FACTS, "fact(s)");
}

/** The cached answer, or null when nothing has been fetched yet. Null means
 * "ask again later", never "there is nothing" — the caller runs this turn
 * without memory rather than waiting for the network. */
export function peekRecalledFacts(subject: string, _candidateName?: string): string[] | null {
  if (!apiKey() || !subject.trim()) return [];
  return cacheGet(`facts:${factTags(subject).join("+")}`);
}

// ——— recalling what we have already ASKED ———
//
// The core of "never ask the same question twice". Before this, only ANSWERS
// were ever stored, so there was no data on earth with which to avoid repeating
// a question — the feature could not work, however well the rest was wired.

/** Every stored question carries this, and recall splits on it. Keeping the
 * framing in the document (rather than storing a bare question) is what makes
 * the record readable in the Supermemory console and searchable at all. */
const ASKED_DOC_MARKER = "interview question:";
const ASKED_QUERY = "interview question asked in an earlier session";

/** Questions this candidate has already been asked in this round type. */
export async function recallAskedQuestions(subject: string, roundType: string): Promise<string[]> {
  if (!apiKey() || !subject.trim()) return localAsked(subject, roundType);
  const tag = askedTagFor(subject, roundType);
  const prev = previousAskedTagFor(subject, roundType);
  const remote = await searchCached(`asked:${tag}`, prev ? [tag, prev] : [tag], ASKED_QUERY, MAX_RECALLED_QUESTIONS, "asked question(s)");
  return mergeAsked(remote.map(questionFromDoc), localAsked(subject, roundType));
}

/** Cache-only read. null means nothing is known AT ALL — the store has not been
 * reached yet and this session has asked nothing.
 *
 * Note what that is NOT: a cold store does not hide what this round has already
 * asked. A write is not searchable for ~20s, so the question put to the
 * candidate ninety seconds ago — precisely the one that must not be repeated —
 * can only ever come from the in-process record, and it outranks the cold
 * remote read rather than being masked by it. */
export function peekAskedQuestions(subject: string, roundType: string): string[] | null {
  const local = localAsked(subject, roundType);
  if (!apiKey() || !subject.trim()) return local;
  const remote = cacheGet(`asked:${askedTagFor(subject, roundType)}`);
  if (remote === null) return local.length ? local : null;
  return mergeAsked(remote.map(questionFromDoc), local);
}

function mergeAsked(remote: string[], local: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of [...local, ...remote]) {
    const k = questionKey(q);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(q);
  }
  return out;
}

/** Strip the stored framing back off: `Asked Hari this hr interview question:
 * "…"` → `…`. Tolerant of anything that lost the marker. */
function questionFromDoc(chunk: string): string {
  const at = chunk.indexOf(ASKED_DOC_MARKER);
  const tail = at === -1 ? chunk : chunk.slice(at + ASKED_DOC_MARKER.length);
  return tail
    .trim()
    .replace(/^["'“]+/, "")
    .replace(/["'”]+$/, "")
    .trim()
    .slice(0, MAX_QUESTION_CHARS);
}

// ——— priming: how recall stays off the critical path ———

/** Go and get everything, in the background, and never make anyone wait.
 *
 * Called on the session's FIRST turn, which the client pre-fetches during the
 * mic check — so the one search of the session happens while the candidate is
 * still saying "testing, one two". Every later turn reads the warm cache
 * synchronously. Idempotent: calling it on every turn costs nothing. */
export function primeCandidateMemory(opts: {
  subject: string;
  roundType: string;
  candidateName?: string;
  query?: string;
}): void {
  if (!apiKey() || !opts.subject.trim()) return;
  void recallCandidate(opts.subject, opts.query ?? STANDING_QUERY, { candidateName: opts.candidateName });
  void recallAskedQuestions(opts.subject, opts.roundType);
}

// ——— writing ———

/** Written this process already — cheap guard against storing the same fact
 * repeatedly when a candidate repeats themselves or retries an answer. */
const written = new Set<string>();
/** Same bound, same reasoning as the recall cache: a server that runs for weeks
 * must not grow a set forever. Dropping entries only risks a duplicate write. */
const MAX_WRITTEN_KEYS = 2000;

function markWritten(key: string): boolean {
  if (written.has(key)) return false;
  if (written.size >= MAX_WRITTEN_KEYS) written.clear();
  written.add(key);
  return true;
}

function writeDocument(content: string, tags: string[], what: string): void {
  const key = apiKey();
  if (!key) return;
  void fetch(`${API}/v3/documents`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ content, containerTags: tags }),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
    .then((r) => {
      if (!r.ok) console.warn(`[memory] ${what} write rejected: supermemory_${r.status}`);
    })
    .catch((err) => {
      console.warn(`[memory] ${what} write failed:`, err instanceof Error ? err.message : err);
    });
}

/** Is this the candidate ASKING rather than telling?
 *
 * Worth filtering because the store filled up with things like "before I answer
 * — what would I actually be doing day to day in this role?" recorded as a fact
 * about the candidate. It is a fact about their curiosity at best, and at worst
 * it comes back in a later session as though they had told us something. Only
 * what they say about THEMSELVES is memory. */
export function worthRemembering(text: string): boolean {
  const t = text.trim();
  return t.length >= MIN_MEMORABLE_CHARS && !isQuestion(t);
}

function isQuestion(text: string): boolean {
  // A long answer that happens to end on a rhetorical question is still an
  // answer; a short "what's the stack" (speech recognition rarely emits the
  // "?") is not.
  return text.trim().split(/\s+/).length < 25 && looksLikeCandidateQuestion(text);
}

/** Store what the candidate said. Fire-and-forget: never awaited on the turn
 * path, never allowed to reject. */
export function rememberAnswer(subject: string, roundType: string, answer: string, candidateName = "the candidate"): void {
  if (!apiKey() || !subject.trim()) return;
  const text = answer.trim();
  if (!worthRemembering(text)) return;
  const tag = containerTagFor(subject);
  if (!markWritten(`${tag}::${text.toLowerCase().replace(/\s+/g, " ")}`)) return;
  // Framed as a fact about the person, not a raw quote, so retrieval reads as
  // knowledge rather than as a stray line of transcript.
  writeDocument(`In a ${roundType} practice interview, ${candidateName} said: ${text}`, [tag], "answer");
}

/** Questions this PROCESS has put to a candidate, per asked-tag, as
 * comparison-key → the question as it was actually spoken. The remote store
 * cannot serve these: a write is not searchable for ~20s, so without them the
 * scripted bank would happily re-pick a question asked ninety seconds ago in
 * the same round. */
const askedThisProcess = new Map<string, Map<string, string>>();

function localAsked(subject: string, roundType: string): string[] {
  return [...(askedThisProcess.get(askedTagFor(subject, roundType))?.values() ?? [])];
}

/** Record that the interviewer actually PUT this question to the candidate.
 *
 * This is the write that did not exist. Everything else in "never ask the same
 * question twice" — the prompt block, the fixture filter — is downstream of it.
 * Fire-and-forget, like every other write here. */
export function rememberAskedQuestion(
  subject: string,
  roundType: string,
  questionText: string,
  candidateName = "the candidate",
): void {
  if (!subject.trim()) return;
  const q = extractQuestion(questionText);
  if (q.length < MIN_QUESTION_CHARS) return;
  const tag = askedTagFor(subject, roundType);
  // In-process first, and unconditionally: this is what the REST of this round
  // reads, and it must work even with no API key at all.
  const local = askedThisProcess.get(tag) ?? new Map<string, string>();
  const key = questionKey(q);
  if (local.has(key)) return;
  local.set(key, q);
  askedThisProcess.set(tag, local);
  if (askedThisProcess.size > MAX_CACHE_ENTRIES) {
    const oldest = askedThisProcess.keys().next();
    if (!oldest.done) askedThisProcess.delete(oldest.value);
  }
  if (!apiKey()) return;
  // A question recalled FROM the store must not be written back into it every
  // time it is avoided — that is how a store fills with its own echo.
  const known = cacheGet(`asked:${tag}`);
  if (known?.some((doc) => questionKey(questionFromDoc(doc)) === key)) return;
  if (!markWritten(`${tag}::${key}`)) return;
  writeDocument(`Asked ${candidateName} this ${roundType} ${ASKED_DOC_MARKER} "${q}"`, [tag], "asked-question");
}

// ——— question text: extracting, comparing, presenting ———

/** The QUESTION out of a spoken interviewer turn.
 *
 * A turn is usually a reaction plus an ask ("That's a fair tradeoff — so where
 * do you see yourself in five years?") or a lead-in plus an exercise, and
 * storing the whole thing would make every record unique and the avoid-list
 * useless: the lead-ins are deliberately varied, so the same exercise would
 * look brand new every session.
 *
 * So: the longest sentence that ends in "?" — length is what separates the real
 * ask from "Sound good?" and "Really?". Failing that (the coding exercise is
 * phrased as an instruction and contains no "?" at all) the longest sentence of
 * any kind, which drops the lead-in and keeps the problem. */
export function extractQuestion(turnText: string): string {
  const text = turnText.trim().replace(/\s+/g, " ");
  if (!text) return "";
  // A sentence ends at ./!/? followed by whitespace (or the end) — never at a
  // dot INSIDE a token. Found in the live store: "how you integrated Next.js
  // with Groq, and how …?" had been split at "Next." and recorded as the
  // fragment "js with Groq, and how …?", the way lib/stream's firstSentence
  // already guards against for the voice.
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_QUESTION_CHARS);
  const longest = (xs: string[]): string | undefined => [...xs].sort((a, b) => b.length - a.length)[0];
  const best = longest(sentences.filter((s) => s.endsWith("?"))) ?? longest(sentences);
  return (best ?? text).slice(0, MAX_QUESTION_CHARS).trim();
}

/** Comparison form. Punctuation and case are exactly what differ between the
 * fixture text, what the model actually said, and what came back out of the
 * store — none of it carries meaning here. */
export function questionKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Long enough that containment cannot fire on a stock phrase two unrelated
 * questions happen to share. */
const MIN_CONTAINMENT_CHARS = 30;

/** Has this candidate had this question before?
 *
 * Not string equality: the stored copy is capped at MAX_QUESTION_CHARS and the
 * spoken copy may have carried a lead-in, so one is routinely a prefix or a
 * substring of the other. Containment is allowed only for strings long enough
 * that it cannot fire by accident. */
export function wasAlreadyAsked(question: string, asked: readonly string[]): boolean {
  const key = questionKey(question);
  if (!key) return false;
  for (const a of asked) {
    const other = questionKey(a);
    if (!other) continue;
    if (other === key) return true;
    if (key.length >= MIN_CONTAINMENT_CHARS && other.includes(key)) return true;
    if (other.length >= MIN_CONTAINMENT_CHARS && key.includes(other)) return true;
  }
  return false;
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

/** The block that actually delivers the feature. Phrased as a prohibition with
 * a reason, because a bare list reads to a model as a set of suggestions — and
 * "in any rewording" matters: the failure mode is asking the same question with
 * different words, which a candidate notices just as fast. */
export function askedQuestionsBlock(questions: readonly string[]): string {
  const list: string[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    const text = extractQuestion(q);
    const key = questionKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push(text);
    if (list.length >= MAX_ASKED_IN_PROMPT) break;
  }
  if (!list.length) return "";
  return [
    `ALREADY ASKED — this candidate has practised with you before, and has already been asked each of the`,
    `questions below. Do NOT ask any of them again, in any rewording. Cover different ground instead:`,
    ...list.map((q) => `- ${q}`),
  ].join("\n");
}

/** Test seam. The caches are module-level on purpose (they outlive a request),
 * which makes them state a test has to be able to clear. */
export function resetMemoryCaches(): void {
  cache.clear();
  inFlight.clear();
  written.clear();
  askedThisProcess.clear();
}
