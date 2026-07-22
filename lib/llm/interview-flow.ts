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
  TECH_GREETING,
  TECH_WRAPUP,
  technicalBank,
} from "@/lib/fixtures/technical-questions";

export const QUESTIONS_PER_INTERVIEW = 5;

/** The coding exercise is ALWAYS main question #3 of a technical round —
 * decided in code, never by a model, so the editor UI is deterministic. */
export const CODING_QUESTION_SLOT = 3;

type FlowQuestion = HrQuestion & { coding?: boolean };

// Deterministic per-session question selection: seed derived from the candidate
// name only, so the same session (same name, growing history) always sees the
// same question set — no Math.random(), which would reshuffle mid-interview.
function seededPick(pool: HrQuestion[], seedStr: string, count: number): HrQuestion[] {
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  const rest = [...pool];
  const picked: HrQuestion[] = [];
  for (let i = 0; i < count && rest.length > 0; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    picked.push(rest.splice(seed % rest.length, 1)[0]);
  }
  return picked;
}

/** Up to 2 project-dive questions generated from the profile. Deterministic
 * from the profile alone — the SAME text on every call, because readPosition
 * recognizes past turns by exact-text findIndex over effectiveQuestions. */
export function projectDiveQuestions(profile: ResumeProfile): FlowQuestion[] {
  return profile.projects.slice(0, 2).map((p, i) => ({
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
): FlowQuestion[] {
  const seed = candidateName || "candidate";
  const dives = profile ? projectDiveQuestions(profile) : [];
  if (roundType === "hr") {
    // Profile selects the real-HR canon bank (fresher vs experienced track).
    const bank = profile ? (profile.experienced ? EXPERIENCED_HR_QUESTIONS : FRESHER_HR_QUESTIONS) : HR_QUESTIONS;
    const picked = seededPick(bank, seed, QUESTIONS_PER_INTERVIEW - dives.length);
    if (dives.length === 0) return picked;
    // Dives land at slots 2-3: a bank opener first, then dig into their work.
    return [picked[0], ...dives, ...picked.slice(1)];
  }
  // Technical is DSA + coding ONLY (user directive) — no project dives here;
  // resume anchoring lives in the DSA bank's phrasing and the coding language.
  const picked = seededPick(technicalBank(role), seed, QUESTIONS_PER_INTERVIEW - 1);
  const codingQ = codingQuestionFor(role, codeLanguage);
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
export const DEEP_PROBES: Record<"hr" | "technical", string[]> = {
  hr: [
    "What was the hardest part of that — and how did you handle it?",
    "If you had to do that again tomorrow, what is the one thing you would change?",
    "Who pushed back on you during that, and how did you respond?",
    "What surprised you most once you were actually in that situation?",
  ],
  technical: [
    "What was the hardest part of that — and how did you handle it?",
    "Where does that approach break down — which edge case hurts it most?",
    "What tradeoff did you accept there, and when would it be the wrong call?",
    "If that had to handle ten times the load tomorrow, what breaks first?",
  ],
};

const ALL_DEEP_PROBES = new Set([...DEEP_PROBES.hr, ...DEEP_PROBES.technical]);

// Seeded like seededPick: name + question index, no Math.random — the same
// session always sees the same probe for the same question.
function pickDeepProbe(candidateName: string, roundType: "hr" | "technical", questionIndex: number): string {
  const pool = DEEP_PROBES[roundType];
  const seedStr = `${candidateName || "candidate"}#${questionIndex}`;
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  return pool[seed % pool.length];
}

interface FlowPosition {
  askedMain: number; // main questions already asked
  followupsUsed: Map<number, number>; // question index (1-based) -> follow-ups asked (0-2)
  lastWasFollowup: boolean;
  greeted: boolean;
}

/** Reconstruct where we are purely from history — the route is stateless. */
export function readPosition(history: HistoryEntry[], questions: FlowQuestion[]): FlowPosition {
  const pos: FlowPosition = { askedMain: 0, followupsUsed: new Map(), lastWasFollowup: false, greeted: false };
  for (const h of history) {
    if (h.speaker !== "interviewer") continue;
    if (!pos.greeted) {
      pos.greeted = true;
      continue;
    }
    const mainIdx = questions.findIndex((q) => h.text === q.text);
    if (mainIdx >= 0) {
      pos.askedMain = mainIdx + 1;
      pos.lastWasFollowup = false;
      continue;
    }
    const fIdx = questions.findIndex((q) => q.followup && h.text === q.followup);
    if (fIdx >= 0) {
      pos.followupsUsed.set(fIdx + 1, (pos.followupsUsed.get(fIdx + 1) ?? 0) + 1);
      pos.lastWasFollowup = true;
      continue;
    }
    // Generic second-level probe: attributed to the question current when it
    // was asked — history is sequential, so that is askedMain at this point.
    if (ALL_DEEP_PROBES.has(h.text) && pos.askedMain >= 1) {
      pos.followupsUsed.set(pos.askedMain, (pos.followupsUsed.get(pos.askedMain) ?? 0) + 1);
      pos.lastWasFollowup = true;
    }
  }
  return pos;
}

/** Follow-up heuristic: thin answers (short, or missing all expected keywords)
 * earn a deeper probe — applied at each chain level, never on the coding slot. */
export function wantsFollowup(answer: string, q: FlowQuestion): boolean {
  if (q.coding || !q.followup) return false;
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  if (words < 25) return true;
  const lower = answer.toLowerCase();
  return !q.expectKeywords.some((k) => lower.includes(k));
}

export function computeNextTurn(
  candidateName: string,
  history: HistoryEntry[],
  roundType: "hr" | "technical" = "hr",
  role: RolePreset = "general",
  profile?: ResumeProfile,
  codeLanguage?: CodeLanguage,
): InterviewerTurn {
  // Callers must pass the SAME profile on every call of a session — the
  // question set (banks + generated dives) derives from it deterministically.
  const questions = effectiveQuestions(candidateName, roundType, role, profile, codeLanguage);
  const pos = readPosition(history, questions);
  const greet = roundType === "technical" ? TECH_GREETING : GREETING;
  const wrap = roundType === "technical" ? TECH_WRAPUP : WRAPUP;

  if (!pos.greeted) {
    const text = profile ? composeResumeGreeting(candidateName, profile) : greet(candidateName || "there");
    return { type: "greeting", text, questionIndex: 0, done: false };
  }

  const lastCandidate = [...history].reverse().find((h) => h.speaker === "candidate");
  const currentQ = pos.askedMain >= 1 ? questions[pos.askedMain - 1] : null;

  // Candidate just answered on the current question → maybe probe deeper.
  // Chain of up to MAX_FOLLOWUPS_PER_QUESTION: the canned follow-up first,
  // then one seeded generic probe — same wantsFollowup heuristic at each level.
  const used = pos.followupsUsed.get(pos.askedMain) ?? 0;
  if (currentQ && lastCandidate && used < MAX_FOLLOWUPS_PER_QUESTION && wantsFollowup(lastCandidate.text, currentQ)) {
    const text = used === 0 ? currentQ.followup : pickDeepProbe(candidateName, roundType, pos.askedMain);
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
