import type { CodeLanguage, HistoryEntry, InterviewerTurn, ResumeProfile, RolePreset } from "@/lib/types";
import {
  EXPERIENCED_HR_QUESTIONS,
  FRESHER_HR_QUESTIONS,
  GREETING,
  HR_QUESTIONS,
  WRAPUP,
  type HrQuestion,
} from "@/lib/fixtures/hr-questions";
import {
  CODING_INTRO,
  codingQuestionFor,
  codingSeedFrom,
  TECH_GREETING,
  TECH_WRAPUP,
  technicalBank,
} from "@/lib/fixtures/technical-questions";
import { isNoAnswer } from "@/lib/llm/parse";
import { wasAlreadyAsked } from "@/lib/memory";

export const QUESTIONS_PER_INTERVIEW = 5;

/** The coding exercise is ALWAYS main question #3 of a technical round —
 * decided in code, never by a model, so the editor UI is deterministic. */
export const CODING_QUESTION_SLOT = 3;

type FlowQuestion = HrQuestion & { coding?: boolean };

/** How a caller narrows the scripted bank. Both fields are optional and the
 * defaults reproduce the old name-only behaviour exactly. */
export interface QuestionSelection {
  /** Fixed for one session, different between sessions — see sessionSeedFrom. */
  sessionSeed?: string;
  /** Questions long-term memory says this candidate has already been asked. */
  avoid?: readonly string[];
}

/** What makes one session's question set differ from the next one's.
 *
 * It has to be two things at once: STABLE for the whole of a session, because
 * readPosition recognises past turns by exact-text matching against this very
 * set and a seed that shifted mid-interview would orphan every question already
 * asked; and DIFFERENT between sessions, or every candidate gets the same
 * opening forever — which is what the name-only seed did.
 *
 * The opening interviewer turn is the only thing that satisfies both. It exists
 * from the first call onward and never changes after it, and in production it
 * is written fresh by the model each session, so it differs even for the same
 * person on the same day. (With no model at all the greeting is a fixture and
 * this degrades to the old name-only variety — in that configuration the
 * cross-session variety comes from `avoid` instead.) */
export function sessionSeedFrom(candidateName: string, history: readonly HistoryEntry[]): string {
  const opening = history.find((h) => h.speaker === "interviewer")?.text ?? "";
  return `${candidateName || "candidate"}|${opening}`;
}

/** FNV-1a, matching the coding-pool hash in fixtures/technical-questions.ts.
 * The old `h * 31 + c` sum lets the low bits depend almost entirely on the last
 * few characters, and the session seed is a whole opening sentence — mostly
 * shared text with a different tail. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** xorshift32, deliberately NOT the linear congruential generator this used to
 * use. An LCG's low-order bits have a very short period — bit k repeats every
 * 2^(k+1) draws — and `% pool.length` reads exactly those bits. Measured: two
 * genuinely different sessions kept drawing the identical first question out of
 * a ten-question bank, which is the whole bug this selection exists to fix. */
function rng(seedStr: string): () => number {
  let s = hash32(seedStr) || 1; // xorshift is stuck at zero
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

// Deterministic per-session question selection: same seed in, same set out — no
// Math.random(), which would reshuffle mid-interview.
function seededPick(pool: HrQuestion[], seedStr: string, count: number, avoid: readonly string[] = []): HrQuestion[] {
  const next = rng(seedStr);
  // Questions this candidate has already had go to the BACK of the queue rather
  // than out of the bank. A nine-question bank owes five slots per round, so by
  // the third session an outright filter would run dry and short-change the
  // round — a repeat is bad, a two-question interview is worse.
  const fresh = avoid.length ? pool.filter((q) => !wasAlreadyAsked(q.text, avoid)) : [...pool];
  const stale = avoid.length ? pool.filter((q) => wasAlreadyAsked(q.text, avoid)) : [];
  const picked: HrQuestion[] = [];
  for (const tier of [fresh, stale]) {
    while (picked.length < count && tier.length > 0) {
      picked.push(tier.splice(next() % tier.length, 1)[0]);
    }
  }
  return picked;
}

/** Up to 2 project-dive questions generated from the profile. Deterministic
 * from the profile alone — the SAME text on every call, because readPosition
 * recognizes past turns by exact-text findIndex over effectiveQuestions. */
export function projectDiveQuestions(profile: ResumeProfile): FlowQuestion[] {
  // Deduped by name: two identical dives would produce identical question
  // text, and readPosition's exact-text matching would then re-ask forever.
  const seen = new Set<string>();
  const unique = profile.projects.filter((p) => {
    const k = p.name.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.slice(0, 2).map((p, i) => ({
    id: 400 + i,
    text: `Walk me through ${p.name} — what was the hardest part?`,
    followup: `If you rebuilt ${p.name} from scratch today, what would you do differently?`,
    expectKeywords: ["built", "problem", "because", "learned", "designed"],
  }));
}

export function effectiveQuestions(
  candidateName: string,
  roundType: "hr" | "technical",
  role: RolePreset,
  profile?: ResumeProfile,
  codeLanguage?: CodeLanguage,
  /** Coding-problem seed (codingSeedFrom) — MUST match what the client uses
   * for the editor, or the interviewer speaks one problem and the editor
   * shows another's starter. */
  codingSeed?: string,
  selection: QuestionSelection = {},
): FlowQuestion[] {
  const seed = selection.sessionSeed || candidateName || "candidate";
  const avoid = selection.avoid ?? [];
  const dives = profile ? projectDiveQuestions(profile) : [];
  if (roundType === "hr") {
    // Profile selects the real-HR canon bank (fresher vs experienced track).
    const bank = profile ? (profile.experienced ? EXPERIENCED_HR_QUESTIONS : FRESHER_HR_QUESTIONS) : HR_QUESTIONS;
    const picked = seededPick(bank, seed, QUESTIONS_PER_INTERVIEW - dives.length, avoid);
    if (dives.length === 0) return picked;
    // Dives land at slots 2-3: a bank opener first, then dig into their work.
    return [picked[0], ...dives, ...picked.slice(1)];
  }
  // Technical is DSA + coding ONLY (user directive) — no project dives here;
  // resume anchoring lives in the DSA bank's phrasing and the coding language.
  const picked = seededPick(technicalBank(role), seed, QUESTIONS_PER_INTERVIEW - 1, avoid);
  // NOT filtered by `avoid`: the coding problem is chosen from codingSeed, and
  // the client's editor derives its starter from the SAME seed. Varying it here
  // would make the interviewer speak one problem while the editor showed
  // another's starter. Making the exercise memory-aware needs the client to
  // agree on the seed — see the report.
  const codingQ = codingQuestionFor(role, codeLanguage, codingSeed);
  const codingEntry: FlowQuestion = {
    id: codingQ.id,
    text: `${CODING_INTRO} ${codingQ.text}`,
    followup: "",
    expectKeywords: [],
    coding: true,
  };
  const out = [...picked];
  out.splice(CODING_QUESTION_SLOT - 1, 0, codingEntry);
  return out;
}

// ——— deterministic resume-aware greeting (single source — claude-cli
// delegates here via computeNextTurn; instant, code-not-model) ———

function spokenFirstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] || "there";
  // ALL-CAPS resume banners read badly aloud — title-case them.
  return /^[A-Z]{2,}$/.test(first) ? first[0] + first.slice(1).toLowerCase() : first;
}

/** Highlight line → something speakable mid-sentence: bullets and trailing
 * punctuation dropped, first letter lowered unless it starts an acronym. */
function speakableHighlight(h: string): string {
  let s = h.replace(/^\s*(?:[-•*·◦▪‣→]|\d+[.)])\s*/, "").replace(/[.;:]+$/, "").trim();
  if (s.length > 80) s = s.slice(0, 80).replace(/\s+\S*$/, "");
  if (/^[A-Z][a-z]/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

function complimentFrom(profile: ResumeProfile): string {
  if (profile.highlight) return `${speakableHighlight(profile.highlight)} — that genuinely caught my eye`;
  if (profile.projects.length) return `${profile.projects[0].name} caught my eye`;
  if (profile.skills.length) return `the ${profile.skills.slice(0, 2).join(" and ")} work caught my eye`;
  return `it reads well`;
}

function experiencedLead(profile: ResumeProfile): string {
  const company = profile.companies[0]; // resumes list most recent first
  const years = profile.yearsOfExperience;
  if (years && company) return `So, ${years} ${years === 1 ? "year" : "years"} at ${company} — let's start there.`;
  if (company) return `So, your time at ${company} — let's start there.`;
  if (years) return `So, ${years} ${years === 1 ? "year" : "years"} of experience — let's start there.`;
  return `So, let's start with your experience.`;
}

/** "Hi {name} — I went through your resume, and {compliment}. {lead}" —
 * two sentences max, speakable, composed from the profile in code so the
 * session opens instantly with zero model latency. */
export function composeResumeGreeting(candidateName: string, profile: ResumeProfile): string {
  const first = spokenFirstName(profile.name ?? candidateName);
  const lead = profile.experienced
    ? experiencedLead(profile)
    : "Let's start with the project that taught you the most.";
  return `Hi ${first} — I went through your resume, and ${complimentFrom(profile)}. ${lead}`;
}

/** Max follow-ups per question in the scripted fallback: the fixture's canned
 * follow-up, then one generic second-level probe — deterministic depth. */
export const MAX_FOLLOWUPS_PER_QUESTION = 2;

/** Second-level probes for the scripted fallback. Every string here must stay
 * distinct from all fixture question/followup text — readPosition attributes
 * them by exact-text matching, so a collision would corrupt the position. */
// There must be at least QUESTIONS_PER_INTERVIEW of these per round. Each main
// question can take one deep probe, so a pool smaller than the round guarantees
// a verbatim repeat by the pigeonhole principle — with five questions and four
// probes, two questions were ALWAYS given the same line.
export const DEEP_PROBES: Record<"hr" | "technical", string[]> = {
  hr: [
    "What was the hardest part of that — and how did you handle it?",
    "If you had to do that again tomorrow, what is the one thing you would change?",
    "Who pushed back on you during that, and how did you respond?",
    "What surprised you most once you were actually in that situation?",
    "Looking back, what would you tell yourself at the start of that?",
    "How did you know when it was actually finished?",
  ],
  technical: [
    "What was the hardest part of that — and how did you handle it?",
    "Where does that approach break down — which edge case hurts it most?",
    "What tradeoff did you accept there, and when would it be the wrong call?",
    "If that had to handle ten times the load tomorrow, what breaks first?",
    "How would you test that — what is the first thing you would check?",
    "What did you rule out before you settled on that approach?",
  ],
};

const ALL_DEEP_PROBES = new Set([...DEEP_PROBES.hr, ...DEEP_PROBES.technical]);

/** A seeded PERMUTATION of the probe pool for this session.
 *
 * Not an independent draw per question, which is what this used to do: two
 * different question indices collide as soon as the pool is smaller than the
 * round (and often sooner), and the round then speaks the same probe twice.
 * Walking a shuffled order spends every probe before any of them comes round
 * again. Seeded like seededPick, so one session always hears the same order and
 * two sessions do not. */
function probeOrder(sessionSeed: string, roundType: "hr" | "technical"): string[] {
  const out = [...DEEP_PROBES[roundType]];
  const next = rng(`probes#${sessionSeed || "candidate"}#${roundType}`);
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickDeepProbe(sessionSeed: string, roundType: "hr" | "technical", questionIndex: number): string {
  const order = probeOrder(sessionSeed, roundType);
  // questionIndex is 1-based; index 0 (a turn with no main question yet) maps
  // to the first probe rather than wrapping to the last.
  return order[Math.max(0, questionIndex - 1) % order.length];
}

interface FlowPosition {
  askedMain: number; // main questions already asked
  followupsUsed: Map<number, number>; // question index (1-based) -> follow-ups asked (0-2)
  lastWasFollowup: boolean;
  greeted: boolean;
  /** Interviewer turns that match no fixture text — a model was driving. */
  unknownTurns: number;
}

/** A silent listening window is re-asked once, in gentler words. Recognised
 * by readPosition through its fixture suffix so it never counts as unknown. */
const REASK_PREFIX = "No rush — let me put that differently. ";

/** Reconstruct where we are purely from history — the route is stateless. */
export function readPosition(history: HistoryEntry[], questions: FlowQuestion[]): FlowPosition {
  const pos: FlowPosition = {
    askedMain: 0,
    followupsUsed: new Map(),
    lastWasFollowup: false,
    greeted: false,
    unknownTurns: 0,
  };
  for (const h of history) {
    if (h.speaker !== "interviewer") continue;
    if (!pos.greeted) {
      pos.greeted = true;
      continue;
    }
    // Exact match, or a re-ask of the same question (prefix + the fixture text).
    const mainIdx = questions.findIndex((q) => h.text === q.text || h.text === REASK_PREFIX + q.text);
    if (mainIdx >= 0) {
      pos.askedMain = Math.max(pos.askedMain, mainIdx + 1);
      pos.lastWasFollowup = false;
      continue;
    }
    const fIdx = questions.findIndex(
      (q) => q.followup && (h.text === q.followup || h.text === REASK_PREFIX + q.followup),
    );
    if (fIdx >= 0) {
      if (!h.text.startsWith(REASK_PREFIX)) {
        pos.followupsUsed.set(fIdx + 1, (pos.followupsUsed.get(fIdx + 1) ?? 0) + 1);
      }
      pos.lastWasFollowup = true;
      continue;
    }
    // Generic second-level probe: attributed to the question current when it
    // was asked — history is sequential, so that is askedMain at this point.
    if (ALL_DEEP_PROBES.has(h.text) && pos.askedMain >= 1) {
      pos.followupsUsed.set(pos.askedMain, (pos.followupsUsed.get(pos.askedMain) ?? 0) + 1);
      pos.lastWasFollowup = true;
      continue;
    }
    pos.unknownTurns++;
  }
  return pos;
}

/** The text most recently asked by the interviewer (any fixture or probe). */
function lastAskedText(history: HistoryEntry[]): string | null {
  const last = [...history].reverse().find((h) => h.speaker === "interviewer");
  if (!last) return null;
  return last.text.startsWith(REASK_PREFIX) ? last.text.slice(REASK_PREFIX.length) : last.text;
}

/** How many candidate entries at the END of the history are silence. */
function trailingSilences(history: HistoryEntry[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.speaker !== "candidate") continue;
    if (!isNoAnswer(h.text)) break;
    n++;
  }
  return n;
}

/** Follow-up heuristic: thin answers (short, or missing all expected keywords)
 * earn a deeper probe — applied at each chain level, never on the coding slot.
 * Keywords match on word boundaries: "i " must not be satisfied by "in". */
export function wantsFollowup(answer: string, q: FlowQuestion): boolean {
  if (q.coding || !q.followup) return false;
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  if (words < 25) return true;
  const lower = ` ${answer.toLowerCase().replace(/\s+/g, " ")} `;
  return !q.expectKeywords.some((k) => {
    const key = k.trim().toLowerCase();
    if (!key) return false;
    // Non-word keywords ("o(1)", "two pointer") match as substrings.
    if (!/^[a-z][a-z' ]*$/.test(key)) return lower.includes(key);
    return new RegExp(`(?<![a-z'])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z'])`).test(lower);
  });
}

export function computeNextTurn(
  candidateName: string,
  history: HistoryEntry[],
  roundType: "hr" | "technical" = "hr",
  role: RolePreset = "general",
  profile?: ResumeProfile,
  codeLanguage?: CodeLanguage,
  selection: QuestionSelection = {},
): InterviewerTurn {
  // Callers must pass the SAME profile on every call of a session — the
  // question set (banks + generated dives) derives from it deterministically.
  // The coding seed is shared with the client's editor (codingSeedFrom).
  const sessionSeed = selection.sessionSeed ?? sessionSeedFrom(candidateName, history);
  const questions = effectiveQuestions(
    candidateName,
    roundType,
    role,
    profile,
    codeLanguage,
    codingSeedFrom(candidateName, history),
    { sessionSeed, avoid: selection.avoid },
  );
  const pos = readPosition(history, questions);
  const greet = roundType === "technical" ? TECH_GREETING : GREETING;
  const wrap = roundType === "technical" ? TECH_WRAPUP : WRAPUP;

  if (!pos.greeted) {
    const text = profile ? composeResumeGreeting(candidateName, profile) : greet(candidateName || "there");
    return { type: "greeting", text, questionIndex: 0, done: false };
  }

  // Rescue mid-interview (a model was driving, then failed): the fixture bank
  // must not restart at question one, and must not re-open the code editor.
  if (pos.unknownTurns > 0) {
    const answers = history.filter((h) => h.speaker === "candidate" && !isNoAnswer(h.text)).length;
    pos.askedMain = Math.max(pos.askedMain, Math.min(QUESTIONS_PER_INTERVIEW, Math.ceil(answers / 3)));
    const codingDone = history.some((h) => h.speaker === "interviewer" && /editor is open|use the editor/i.test(h.text));
    if (codingDone) {
      const slot = questions.findIndex((q) => q.coding);
      if (slot >= 0 && pos.askedMain < slot + 1) pos.askedMain = slot + 1;
    }
  }

  const lastCandidate = [...history].reverse().find((h) => h.speaker === "candidate");
  const currentQ = pos.askedMain >= 1 ? questions[pos.askedMain - 1] : null;

  // Silence is not an answer. The first silent window re-asks the same thing
  // in gentler words; a second consecutive silence moves on (the room's own
  // give-up policy already offered a rephrase and waited a long time).
  if (lastCandidate && isNoAnswer(lastCandidate.text) && trailingSilences(history) === 1) {
    const asked = lastAskedText(history);
    if (asked && !questions.some((q) => q.coding && q.text === asked)) {
      return {
        type: "reply",
        text: REASK_PREFIX + asked,
        questionIndex: pos.askedMain,
        done: false,
        asked: true,
      };
    }
  }

  // Candidate just answered on the current question → maybe probe deeper.
  // Chain of up to MAX_FOLLOWUPS_PER_QUESTION: the canned follow-up first,
  // then one seeded generic probe — same wantsFollowup heuristic at each level.
  const used = pos.followupsUsed.get(pos.askedMain) ?? 0;
  if (currentQ && lastCandidate && used < MAX_FOLLOWUPS_PER_QUESTION && wantsFollowup(lastCandidate.text, currentQ)) {
    const text = used === 0 ? currentQ.followup : pickDeepProbe(sessionSeed, roundType, pos.askedMain);
    return { type: "followup", text, questionIndex: pos.askedMain, done: false };
  }

  if (pos.askedMain >= QUESTIONS_PER_INTERVIEW) {
    return { type: "wrapup", text: wrap(candidateName || "and good luck"), questionIndex: 0, done: true };
  }

  const next = questions[pos.askedMain];
  return {
    type: "question",
    text: next.text,
    questionIndex: pos.askedMain + 1,
    done: false,
    ...(next.coding ? { coding: true } : {}),
  };
}
