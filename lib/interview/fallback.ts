import { secondPerson } from "@/lib/interview/claims";

import { alreadyAnswered, isSameQuestion } from "@/lib/interview/dedupe";
import { strongestAndWeakest } from "@/lib/interview/engine";
import { COMPETENCIES, competencyLabel, type Difficulty } from "@/lib/interview/roles";
import type { AnswerAnalysis, InterviewState, ProposedMove, TurnDecision } from "@/lib/interview/types";
import { reaction, type ReactionContext, type VoiceEngineKind } from "@/lib/expressions";
import { companyBriefFor } from "@/lib/fixtures/company-brief";
import { GREETING } from "@/lib/fixtures/hr-questions";
import { TECH_GREETING } from "@/lib/fixtures/technical-questions";
import { composeResumeGreeting } from "@/lib/llm/interview-flow";
import { extractQuestion } from "@/lib/memory";
import { isUnheard } from "@/lib/llm/parse";
import type { ResumeProfile } from "@/lib/types";

// The deterministic interviewer — what speaks when no model can.
//
// It used to be a five-question bank matched by exact text, so an outage turned
// a conversation into a form. Now it executes the same validated move the model
// would have made, against the same state: it follows up on the thing they just
// named, asks for the example a vague answer lacked, verifies the resume claim,
// raises the contradiction with both quotes. The words are templated; the
// DECISION is the same adaptive one.
//
// Every templated question goes through the same memory checks as a model
// question: not asked before (in any wording), not already answered. The first
// version reused three "be specific" lines with no such check, and under a
// rate limit that was the sound of the interviewer asking the same thing again.

/** A claim or contradiction text as the interviewer says it back: second
 * person, no leading "you", no trailing full stop (the template adds its own). */
function said(text: string): string {
  return secondPerson(text.trim()).replace(/^you\s+/i, "").replace(/[.!?\s]+$/, "");
}

function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The first candidate, in seeded order, that memory does not rule out. */
function pickFresh(candidates: readonly string[], seed: string, s: InterviewState, answers: readonly string[]): string | null {
  if (!candidates.length) return null;
  const start = hash(seed) % candidates.length;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[(start + i) % candidates.length];
    if (isSameQuestion(c, s.asked)) continue;
    if (alreadyAnswered(c, answers)) continue;
    return c;
  }
  return null;
}

function react(s: InterviewState, last: AnswerAnalysis | null, engine: VoiceEngineKind, override?: ReactionContext): string {
  if (!last || last.quality === "silent") return "";
  const ctx: ReactionContext =
    override ??
    (last.quality === "strong" ? (hash(`${s.sid}|${s.turn}`) % 2 ? "impressed" : "agree")
    : last.quality === "adequate" ? "acknowledge"
    : last.quality === "tap-out" ? "honest"
    : last.flags.includes("overclaim") ? "skeptical"
    : "thinking");
  return reaction(ctx, `${s.sid}|${s.turn}`, engine);
}

/** A probe for a competency at a difficulty that has not been asked yet. */
export function freshProbe(s: InterviewState, competency: string, difficulty: Difficulty, answers: readonly string[] = []): string {
  const def = COMPETENCIES[competency];
  if (!def) return "Tell me more about that — what exactly did you do?";
  const order: Difficulty[] = [difficulty, ...([1, 2, 3] as Difficulty[]).filter((d) => d !== difficulty)];
  for (const d of order) {
    const pick = pickFresh(def.probes[d], `${s.sid}|${competency}|${d}`, s, answers);
    if (pick) return pick;
  }
  return `Let's go one level deeper on ${def.label.toLowerCase()} — what's the part of it you've actually used the most, and what surprised you about it?`;
}

const FOLLOW_UPS = [
  "what would you do differently if you did that again today?",
  "walk me through how that actually worked, step by step.",
  "what was the hardest problem you hit there, and how did you get past it?",
  "how did you know it was working — what did you measure or check?",
  "what broke first when you tested it with real use?",
  "which decision in that are you least sure about now?",
  "what did you rule out before you settled on that?",
  "who else was involved, and which part was only yours?",
];

function followUp(s: InterviewState, last: AnswerAnalysis | null, answers: readonly string[]): string {
  const topic = last?.salient && s.plan.resume?.projects.includes(last.salient) ? last.salient : null;
  const lead = topic ? `On ${topic} —` : "Staying on that —";
  const pick = pickFresh(FOLLOW_UPS, `${s.sid}|fu|${s.turn}`, s, answers);
  if (pick) return `${lead} ${pick}`;
  const comp = s.thread.competency;
  return comp ? freshProbe(s, comp, s.ledger[comp]?.difficulty ?? 2, answers) : `${lead} what's the part of it you would want a second chance at?`;
}

const CLARIFIES = [
  "Can you make that concrete for me? One specific example — what you did, and what happened as a result.",
  "Let's pin that down. Pick one real situation and walk me through exactly what you did.",
  "That's still quite general. What's one specific moment where that actually happened?",
  "Give me the specifics on that — which tool, which decision, what changed because of it?",
  "I'd like one real example there: what was the situation, and what did you personally do?",
];

function clarify(s: InterviewState, last: AnswerAnalysis | null, lastQuestion: string, answers: readonly string[], engine: VoiceEngineKind): string {
  if (!last || last.quality === "silent") {
    const q = extractQuestion(lastQuestion);
    if (last && isUnheard(last.text)) {
      return q
        ? `I could hear you, but the words didn't come through on my end — sorry about that. Could you say that once more? ${q}`
        : "I could hear you, but the words didn't come through on my end — sorry about that. Could you say that once more?";
    }
    return q ? `Sorry, I didn't catch anything there. Let me put it another way: ${q}` : "Sorry, I didn't catch that — take a moment. What comes to mind first?";
  }
  if (last.quality === "tap-out") {
    const comp = s.thread.competency;
    return comp ? `${reaction("honest", `${s.sid}|${s.turn}`, engine)} Let's try an easier angle: ${freshProbe(s, comp, 1, answers)}` : "That's okay. What would your first guess be?";
  }
  const pick = pickFresh(CLARIFIES, `${s.sid}|clarify|${s.turn}`, s, answers);
  return `${reaction("clarify", `${s.sid}|${s.turn}`, engine)} ${pick ?? "Which part of that did you do yourself, and what was the result?"}`;
}

const CHALLENGES = [
  "That's a big claim. What's the evidence — what specifically did you do that shows it?",
  "What's one concrete example that backs that up?",
  "If I asked your teammate, would they describe your part the same way? What would they say you did?",
];

function challenge(s: InterviewState, move: ProposedMove, last: AnswerAnalysis | null, answers: readonly string[], engine: VoiceEngineKind): string {
  const quote = move.evidence ?? "";
  const lead = quote ? `${reaction("skeptical", `${s.sid}|${s.turn}`, engine)} I want to push on something you said — "${quote.slice(0, 120)}".` : `${reaction("skeptical", `${s.sid}|${s.turn}`, engine)} I'm not fully convinced yet.`;
  const ask = pickFresh(last?.flags.includes("overclaim") ? CHALLENGES : [...CHALLENGES].reverse(), `${s.sid}|ch|${s.turn}`, s, answers) ?? CHALLENGES[1];
  return `${lead} ${ask}`;
}

function probeResume(s: InterviewState, move: ProposedMove, answers: readonly string[]): string {
  const claim = s.claims.find((c) => c.id === move.target);
  if (!claim) return followUp(s, null, answers);
  const candidates =
    claim.source === "resume" && claim.kind === "skill"
      ? [
          `Your resume lists ${claim.quote}. Tell me about the last thing you actually built with it — what part did you write yourself?`,
          `On ${claim.quote} from your resume — what's something about it you only learned by using it, not from a tutorial?`,
        ]
      : claim.source === "resume"
        ? [
            `Your resume mentions ${claim.quote}. Which part of it did you build yourself, and what was the hardest bit?`,
            `On ${claim.quote} — what's one decision in it you made alone, and what would you change now?`,
          ]
        : [
            `Earlier you said you ${said(claim.text)}. Walk me through exactly what that involved — what did you do yourself?`,
            `You mentioned you ${said(claim.text)}. What was the trickiest part of that, specifically?`,
          ];
  return pickFresh(candidates, `${s.sid}|pr|${claim.id}`, s, answers) ?? followUp(s, null, answers);
}

function testContradiction(s: InterviewState, move: ProposedMove, answers: readonly string[], engine: VoiceEngineKind): string {
  const c = s.contradictions.find((x) => x.id === move.target);
  if (!c) return followUp(s, null, answers);
  const lead = reaction("clarify", `${s.sid}|${s.turn}`, engine);
  if (c.kind === "resume") {
    return `${lead} Your resume lists ${c.quoteA}, but just now you said you ${said(c.textB)}. What's the actual story there?`;
  }
  if (c.kind === "polarity" || c.kind === "timeline") {
    return `${lead} Earlier you mentioned that you ${said(c.textA)}. Just now you said you ${said(c.textB)}. Help me square those — which is closer to the truth?`;
  }
  return `${lead} Earlier you mentioned that you ${said(c.textA)}. Just now you said you ${said(c.textB)}. Can you clarify exactly what part you owned?`;
}

function handOver(s: InterviewState): string {
  const options = [
    "That's everything I wanted to cover from my side. What would you like to ask me — about the role, the team, or anything else?",
    "Okay, I've got a good picture now. Your turn — what would you like to know about the job or the team?",
    "That's all my questions. Before we finish, what would you like to ask me?",
  ];
  return options[hash(`${s.sid}|handover`) % options.length];
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
  /** The candidate's recent substantive answers — what must not be asked again. */
  answers?: readonly string[];
  engine?: VoiceEngineKind;
}

export function fallbackText(ctx: FallbackContext): string {
  const { state: s, decision: d, move } = ctx;
  const answers = ctx.answers ?? [];
  const engine = ctx.engine ?? "kokoro";
  const first = ctx.candidateName.trim().split(/\s+/)[0] || "there";
  switch (d.kind) {
    case "open":
      if (ctx.profile) return composeResumeGreeting(ctx.candidateName, ctx.profile);
      return s.plan.roundType === "technical" ? TECH_GREETING(first) : GREETING(first);
    case "code-review":
      return (
        pickFresh(
          [
            "Thanks — let's look at what you wrote. What's the time and space complexity of your solution, and which input would break it first?",
            "Okay, let's talk through your code. Which edge case did you think about most, and how does your solution handle it?",
            "Got it. If the input were ten times larger, what in your solution would you change first, and why?",
          ],
          `${s.sid}|review`,
          s,
          answers,
        ) ?? "Thanks. What does your solution do with an empty input?"
      );
    case "hand-over":
      return `${react(s, d.last, engine)} ${handOver(s)}`.trim();
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
      const comp = m.competency ?? s.thread.competency;
      switch (m.action) {
        case "follow_up":
          return `${react(s, d.last, engine, d.last?.quality === "strong" ? "deeper" : undefined)} ${followUp(s, d.last, answers)}`.trim();
        case "clarify":
          return clarify(s, d.last, ctx.lastQuestion, answers, engine);
        case "challenge":
          return challenge(s, m, d.last, answers, engine);
        case "probe_resume":
          return `${react(s, d.last, engine)} ${probeResume(s, m, answers)}`.trim();
        case "adjust_difficulty": {
          const current = comp ? (s.ledger[comp]?.difficulty ?? 2) : 2;
          const next = Math.max(1, Math.min(3, current + (m.direction === "down" ? -1 : 1))) as Difficulty;
          if (!comp) return `${react(s, d.last, engine)} ${followUp(s, d.last, answers)}`.trim();
          const lead = m.direction === "down" ? `${react(s, d.last, engine, "honest")} Let's take a step back.` : `${reaction("difficult", `${s.sid}|${s.turn}`, engine)}`;
          // Going up on a story they have just told: dig into THAT story before
          // reaching for a canned probe — a canned "tell me about a time…" can
          // restate what they just narrated in other words, which a lexical
          // memory check cannot see (live run: "something broke before a
          // release" right after "the payment page broke the night before").
          const fresh = (s.ledger[comp]?.evidence.length ?? 0) < 2 && m.direction !== "down" ? pickFresh(FOLLOW_UPS, `${s.sid}|fu|${s.turn}`, s, answers) : null;
          return `${lead} ${fresh ? `Staying with that — ${fresh}` : freshProbe(s, comp, next, answers)}`.trim();
        }
        case "switch_competency": {
          const transition = ["Let's switch gears.", "Let me move us on.", "Okay, different topic.", "Let's change tack."][hash(`${s.sid}|sw|${s.turn}`) % 4];
          return comp
            ? `${react(s, d.last, engine)} ${transition} ${freshProbe(s, comp, s.ledger[comp]?.difficulty ?? s.plan.startingDifficulty, answers)}`.trim()
            : handOver(s);
        }
        case "test_contradiction":
          return testContradiction(s, m, answers, engine);
        case "wrap":
          return `${react(s, d.last, engine)} ${handOver(s)}`.trim();
      }
    }
  }
}
