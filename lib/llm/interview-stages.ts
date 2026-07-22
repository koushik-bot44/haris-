import type { HistoryEntry } from "@/lib/types";

// The shape of the interview — the arc a real interviewer walks, rather than a
// bag of topics picked at random.
//
// This is INTERNAL STATE, and the distinction matters. A stage says what the
// interviewer is currently trying to find out; it never says what to say. The
// model reads the current stage as situational awareness and decides its own
// wording, its own follow-ups, and when the ground is covered. That is the
// difference between an interviewer with a plan and a form with an index.
//
// The old model had no arc at all: a topic number derived from
// `ceil(answers / 3)`, which is why a session could open on teamwork, cut to a
// coding exercise ninety seconds later, and never revisit the candidate's own
// work. Stages fix the ORDER; the conversation engine still owns the words.

export interface Stage {
  key: string;
  /** What the interviewer is trying to learn here — goes into the prompt. */
  goal: string;
}

/** The one stage where the candidate holds the floor and Haris has to answer
 * rather than assess.
 *
 * Every other stage extracts; this one reverses the direction information
 * flows, which is what "two-sided" actually means. Real interviews budget it
 * explicitly — a 45-minute round gives candidate questions a hard 5-minute
 * block, about 11% of the interview — and recruiters weigh what a candidate
 * asks. Haris used to fold it into one clause of the wrap-up ("invite any
 * questions, then finish"), which in practice meant it was skipped.
 *
 * Shared by both rounds because it belongs in both. */
const CANDIDATE_QUESTIONS_STAGE: Stage = {
  key: "candidate-questions",
  goal:
    "STOP INTERVIEWING THEM. Ask them NO further interview questions from here. React to their last answer in one short clause if you " +
    "like, then this turn MUST end by handing them the floor in your own words — the sense of 'that's everything from me, what would " +
    "you like to ask me?'. After that, ANSWER whatever they ask, specifically and honestly, from what you know about the job; if a " +
    "question is a good one, say so. If they ask nothing, offer them something worth asking about rather than closing — a fresher " +
    "often does not know it is allowed to ask.",
};

/** Technical round: background → their work → write code → defend the code →
 * fundamentals → their questions. Deliberately mirrors a real campus technical:
 * nobody opens with a DSA question, nobody sets an exercise before knowing what
 * you can do, and nobody ends without handing the floor back. */
const TECHNICAL_STAGES: Stage[] = [
  {
    key: "background",
    goal: "Find out what they actually know and have built. Open from their resume — the skills they claim and the projects they list. Broad, not deep, and let them talk.",
  },
  {
    key: "projects",
    goal: "Go deep on ONE project they mentioned, technically: what they used and why, how it was structured, the hardest bug, what they would change now. Chase the specifics they name.",
  },
  {
    key: "coding",
    goal: "The hands-on exercise. The editor opens for this; the problem is chosen in code.",
  },
  {
    key: "code-review",
    goal: "Review the code they just wrote, the way a real interviewer does: what is its time and space complexity, which edge cases break it, what would they change. Refer to their actual solution, not a generic one.",
  },
  {
    key: "fundamentals",
    goal: "Now the CS fundamentals and DSA — data structures, complexity, language internals — aimed at the areas their resume and their code suggest are worth probing.",
  },
  CANDIDATE_QUESTIONS_STAGE,
  {
    key: "wrapup",
    goal: "Close warmly: one honest, specific thing they did well, what to work on, and what happens next. Then finish.",
  },
];

/** HR round: who they are → evidence → behaviour under pressure → motivation →
 * the practical questions every real HR round ends on. */
const HR_STAGES: Stage[] = [
  {
    key: "background",
    goal: "Who they are and what they have done — the classic opening. Anchor to their resume: education, skills, what they have built.",
  },
  {
    key: "projects",
    goal: "Their strengths, evidenced by their own work rather than adjectives. Make them prove a claim with something they actually did.",
  },
  {
    key: "behavioural",
    goal: "How they behave with other people and under pressure: teamwork, disagreement, a failure and what they took from it, how they handle deadlines.",
  },
  {
    key: "motivation",
    goal: "Why this company and this role, what they want from the first year, where they think they are heading.",
  },
  {
    key: "practical",
    goal: "The practical ground a real HR round always covers: relocation, expected package (asked once, gently), availability.",
  },
  CANDIDATE_QUESTIONS_STAGE,
  {
    key: "wrapup",
    goal: "Close warmly: one honest, specific thing they did well, what to work on, and what happens next. Then finish.",
  },
];

export function stagesFor(roundType: "hr" | "technical"): Stage[] {
  return roundType === "technical" ? TECHNICAL_STAGES : HR_STAGES;
}

/** Answers before the editor opens. The exercise used to fire after 2, which
 * lands before the candidate has said anything substantial about themselves. */
export const CODING_AFTER_ANSWERS = 4;

/** Answers spent discussing the submitted solution before moving to DSA. */
const CODE_REVIEW_ANSWERS = 2;

/** Answers per stage in the HR round — roughly two exchanges each, which is
 * what a ten-minute round supports. */
const HR_STAGE_SPAN = 2;

/** When Haris stops asking and hands the floor over. HARD_STOP_ANSWERS is 16,
 * so this leaves a real block for the candidate's questions rather than a
 * token gesture as the clock runs out. */
const HAND_OVER_AFTER_ANSWERS = 11;
/** When it closes regardless. */
const CLOSE_AFTER_ANSWERS = 15;

/** The technical round has no answer-count trigger of its own after
 * fundamentals, so it reaches the candidate's turn on the shared threshold
 * above — same as HR. */

export interface StageState {
  stage: Stage;
  index: number;
  total: number;
  next: Stage | null;
}

/** Where the interview has got to. Derived from the transcript because the API
 * is stateless — the client posts history and nothing else. */
export function currentStage(
  roundType: "hr" | "technical",
  history: HistoryEntry[],
  opts: { codingAsked: boolean; answers: number },
): StageState {
  const stages = stagesFor(roundType);
  const { answers, codingAsked } = opts;
  const at = (key: string) => stages.findIndex((s) => s.key === key);

  let idx: number;
  if (roundType === "technical") {
    if (codingAsked) {
      const answersAfterCoding = answersSinceCoding(history);
      idx = answersAfterCoding <= CODE_REVIEW_ANSWERS ? at("code-review") : at("fundamentals");
    } else if (answers >= CODING_AFTER_ANSWERS) {
      idx = at("coding");
    } else {
      idx = answers < 2 ? at("background") : at("projects");
    }
  } else {
    idx = Math.min(at("practical"), Math.floor(answers / HR_STAGE_SPAN));
  }

  // Hand the floor over before closing, and leave room to do it properly rather
  // than being cut off by the hard cap. Two thresholds, not one: a single
  // "jump to wrapup" would skip the candidate's turn entirely, which is exactly
  // how it got skipped when it was only a clause inside the wrap-up.
  if (answers >= HAND_OVER_AFTER_ANSWERS) idx = Math.max(idx, at("candidate-questions"));
  if (answers >= CLOSE_AFTER_ANSWERS) idx = at("wrapup");
  idx = Math.max(0, Math.min(stages.length - 1, idx));
  return { stage: stages[idx], index: idx, total: stages.length, next: stages[idx + 1] ?? null };
}

/** The coding hand-off is recognised by its editor phrasing, which every
 * lead-in shares. Shared by the stage machine and the prompt builder so both
 * agree on whether the exercise has already happened. */
const CODING_HANDOFF = /editor is open|the editor/i;

export function codingAlreadyAsked(history: HistoryEntry[]): boolean {
  return history.some((h) => h.speaker === "interviewer" && CODING_HANDOFF.test(h.text));
}

/** Candidate answers recorded after the editor was handed over. */
function answersSinceCoding(history: HistoryEntry[]): number {
  const at = history.findIndex((h) => h.speaker === "interviewer" && CODING_HANDOFF.test(h.text));
  if (at === -1) return 0;
  return history.slice(at).filter((h) => h.speaker === "candidate").length;
}
