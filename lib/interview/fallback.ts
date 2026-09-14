import { secondPerson } from "@/lib/interview/claims";
import { strongestAndWeakest } from "@/lib/interview/engine";
import { COMPETENCIES, competencyLabel, type Difficulty } from "@/lib/interview/roles";
import type { AnswerAnalysis, InterviewState, ProposedMove, TurnDecision } from "@/lib/interview/types";
import { companyBriefFor } from "@/lib/fixtures/company-brief";
import { GREETING } from "@/lib/fixtures/hr-questions";
import { TECH_GREETING } from "@/lib/fixtures/technical-questions";
import { composeResumeGreeting } from "@/lib/llm/interview-flow";
import { extractQuestion, wasAlreadyAsked } from "@/lib/memory";
import type { ResumeProfile } from "@/lib/types";

// The deterministic interviewer — what speaks when no model can.
//
// It used to be a five-question bank matched by exact text, so an outage turned
// a conversation into a form. Now it executes the same validated move the model
// would have made, against the same state: it follows up on the thing they just
// named, asks for the example a vague answer lacked, verifies the resume claim,
// raises the contradiction with both quotes. The words are templated; the
// DECISION is the same adaptive one.

function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function pickOne<T>(items: T[], seed: string): T {
  return items[hash(seed) % items.length];
}

const REACTIONS: Record<AnswerAnalysis["quality"], string[]> = {
  strong: ["That's a clear answer.", "Good — that's specific.", "Nice, that's the kind of detail I was after."],
  adequate: ["Okay, got it.", "Fair enough.", "Right, that makes sense."],
  vague: ["Okay.", "Hmm, okay.", "Alright."],
  "tap-out": ["That's fine — it's useful to know where the edge is.", "No problem, that's an honest answer.", "Okay, thanks for being straight about it."],
  silent: [""],
};

function reaction(s: InterviewState, last: AnswerAnalysis | null): string {
  if (!last) return "";
  return pickOne(REACTIONS[last.quality], `${s.sid}|react|${s.turn}`);
}

/** A probe for a competency at a difficulty that has not been asked yet. */
export function freshProbe(s: InterviewState, competency: string, difficulty: Difficulty): string {
  const def = COMPETENCIES[competency];
  if (!def) return "Tell me more about that — what exactly did you do?";
  const order: Difficulty[] = [difficulty, ...([1, 2, 3] as Difficulty[]).filter((d) => d !== difficulty)];
  for (const d of order) {
    const pool = def.probes[d];
    const start = hash(`${s.sid}|${competency}|${d}`) % pool.length;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[(start + i) % pool.length];
      if (!wasAlreadyAsked(p, s.asked)) return p;
    }
  }
  return `Let's go one level deeper on ${def.label.toLowerCase()} — what's the part of it you find hardest?`;
}

const FOLLOW_UPS = [
  "what exactly was your part in that, and what would you do differently now?",
  "walk me through how that actually worked, step by step.",
  "what was the hardest problem you hit there, and how did you get past it?",
  "why did you choose that approach over the alternatives?",
  "how did you know it was working — what did you measure or check?",
];

function followUp(s: InterviewState, last: AnswerAnalysis | null): string {
  const topic = last?.salient;
  const base = FOLLOW_UPS.filter((f) => !wasAlreadyAsked(f, s.asked));
  const probe = pickOne(base.length ? base : FOLLOW_UPS, `${s.sid}|fu|${s.turn}`);
  return topic ? `You mentioned ${topic} — ${probe}` : `Let's stay on that — ${probe}`;
}

function clarify(s: InterviewState, last: AnswerAnalysis | null, lastQuestion: string): string {
  if (!last || last.quality === "silent") {
    const q = extractQuestion(lastQuestion);
    return q ? `No rush. Let me put it another way: ${q}` : "No rush — take a moment. What comes to mind first?";
  }
  if (last.quality === "tap-out") {
    const comp = s.thread.competency;
    return comp ? `That's okay. Let's try an easier angle: ${freshProbe(s, comp, 1)}` : "That's okay. What would your first guess be?";
  }
  return pickOne(
    [
      "Can you make that concrete for me? Give me one specific example — what you did, and what happened as a result.",
      "Let's pin that down. Pick one real situation and walk me through exactly what you did.",
      "That's still quite general. What's one specific moment where that actually happened?",
    ],
    `${s.sid}|clarify|${s.turn}`,
  );
}

function challenge(move: ProposedMove, last: AnswerAnalysis | null): string {
  const quote = move.evidence ?? "";
  const lead = quote ? `I want to push on something you said — "${quote.slice(0, 120)}".` : "I'm not fully convinced yet.";
  const ask = last?.flags.includes("overclaim")
    ? "That's a big claim. What's the evidence — what specifically did you do that shows it?"
    : "What's one concrete example that backs that up?";
  return `${lead} ${ask}`;
}

function probeResume(s: InterviewState, move: ProposedMove): string {
  const claim = s.claims.find((c) => c.id === move.target);
  if (!claim) return followUp(s, null);
  if (claim.source === "resume" && claim.kind === "skill") {
    return `Your resume lists ${claim.quote}. Tell me about the last thing you actually built with it — what part did you write yourself?`;
  }
  if (claim.source === "resume") {
    return `Your resume mentions ${claim.quote}. Which part of it did you build yourself, and what was the hardest bit?`;
  }
  return `Earlier you said you ${secondPerson(claim.text)}. Walk me through exactly what that involved — what did you do yourself?`;
}

function testContradiction(s: InterviewState, move: ProposedMove): string {
  const c = s.contradictions.find((x) => x.id === move.target);
  if (!c) return followUp(s, null);
  if (c.kind === "resume") {
    return `Your resume lists ${c.quoteA}, but just now you said you ${secondPerson(c.textB)}. What's the actual story there?`;
  }
  if (c.kind === "polarity" || c.kind === "timeline") {
    return `Earlier you mentioned that you ${secondPerson(c.textA)}. Just now you said you ${secondPerson(c.textB)}. Help me square those — which is closer to the truth?`;
  }
  return `Earlier you mentioned that you ${secondPerson(c.textA)}. Just now you said you ${secondPerson(c.textB)}. Can you clarify exactly what part you owned?`;
}

function handOver(s: InterviewState): string {
  return pickOne(
    [
      "That's everything I wanted to cover from my side. What would you like to ask me — about the role, the team, or anything else?",
      "Okay, I've got a good picture now. Your turn — what would you like to know about the job or the team?",
      "That's all my questions. Before we finish, what would you like to ask me?",
    ],
    `${s.sid}|handover`,
  );
}

/** Answer a candidate's question from the job brief, deterministically. */
export function answerFromBrief(role: string, question: string): string {
  const b = companyBriefFor(role);
  const q = question.toLowerCase();
  if (/\b(stack|tech|technolog|language|framework|tools?)\b/.test(q)) return `The stack is ${b.stack}.`;
  if (/\b(team|who|people|size|colleague)\b/.test(q)) return `You'd join ${b.team}, working on ${b.ships}.`;
  if (/\b(first|day to day|day-to-day|typical|month|start|onboard|training|expect)\b/.test(q)) return `In the first months: ${b.firstMonths}.`;
  if (/\b(mentor|support|help|learn|grow|buddy|manager)\b/.test(q)) return `On support: ${b.mentoring}.`;
  if (/\b(hard|difficult|challenge|worst|downside)\b/.test(q)) return `Honestly, the hard part is that ${b.hard}.`;
  if (/\b(next|process|round|decision|hear back|timeline|result)\b/.test(q)) return `As for next steps: ${b.next}.`;
  return `Good question. What I can tell you is that the team ships ${b.ships}, and in the first months ${b.firstMonths}.`;
}

export interface FallbackContext {
  state: InterviewState;
  decision: TurnDecision;
  move: ProposedMove | null;
  candidateName: string;
  profile?: ResumeProfile;
  lastQuestion: string;
}

export function fallbackText(ctx: FallbackContext): string {
  const { state: s, decision: d, move } = ctx;
  const first = ctx.candidateName.trim().split(/\s+/)[0] || "there";
  switch (d.kind) {
    case "open":
      if (ctx.profile) return composeResumeGreeting(ctx.candidateName, ctx.profile);
      return s.plan.roundType === "technical" ? TECH_GREETING(first) : GREETING(first);
    case "code-review":
      return pickOne(
        [
          "Thanks — let's look at what you wrote. What's the time and space complexity of your solution, and which input would break it first?",
          "Okay, let's talk through your code. Which edge case did you think about most, and how does your solution handle it?",
          "Got it. If the input were ten times larger, what in your solution would you change first, and why?",
        ],
        `${s.sid}|review`,
      );
    case "hand-over":
      return `${reaction(s, d.last)} ${handOver(s)}`.trim();
    case "answer-questions":
      return `${answerFromBrief(s.plan.role, d.last?.text ?? "")} Anything else you'd like to know?`;
    case "close": {
      const { strongest, weakest } = strongestAndWeakest(s);
      const strong = strongest ? ` You were strongest on ${competencyLabel(strongest).toLowerCase()}.` : "";
      const weak = weakest ? ` The thing to work on next is ${competencyLabel(weakest).toLowerCase()}.` : "";
      return `That's the end of our round, ${first} — thank you.${strong}${weak} Your detailed feedback is ready now.`;
    }
    case "coding":
      return "";
    case "move": {
      const m = move ?? d.recommended ?? { action: "wrap" as const };
      const react = reaction(s, d.last);
      const comp = m.competency ?? s.thread.competency;
      let body: string;
      switch (m.action) {
        case "follow_up":
          body = followUp(s, d.last);
          break;
        case "clarify":
          return clarify(s, d.last, ctx.lastQuestion);
        case "challenge":
          body = challenge(m, d.last);
          break;
        case "probe_resume":
          body = probeResume(s, m);
          break;
        case "adjust_difficulty": {
          const current = comp ? s.ledger[comp]?.difficulty ?? 2 : 2;
          const next = Math.max(1, Math.min(3, current + (m.direction === "down" ? -1 : 1))) as Difficulty;
          body = comp
            ? `${m.direction === "down" ? "Let's take a step back." : "Good — let's push a bit further."} ${freshProbe(s, comp, next)}`
            : followUp(s, d.last);
          break;
        }
        case "switch_competency":
          body = comp
            ? `${pickOne(["Let's switch gears.", "Let me move us on.", "Okay, different topic."], `${s.sid}|sw|${s.turn}`)} ${freshProbe(s, comp, s.ledger[comp]?.difficulty ?? s.plan.startingDifficulty)}`
            : handOver(s);
          break;
        case "test_contradiction":
          return testContradiction(s, m);
        case "wrap":
          body = handOver(s);
          break;
      }
      return `${react} ${body}`.trim();
    }
  }
}
