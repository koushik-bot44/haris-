import { secondPerson } from "@/lib/interview/claims";
import { isAssessed, MIN_COVERAGE } from "@/lib/interview/coverage";
import { strongestAndWeakest } from "@/lib/interview/engine";
import { MOVE_PREFIX } from "@/lib/interview/moveline";
import { COMPETENCIES, competencyLabel, DIFFICULTY_LABEL } from "@/lib/interview/roles";
import type { InterviewState, MoveOption, ProposedMove, TurnDecision } from "@/lib/interview/types";

// The interview state rendered for the model: situational awareness plus the
// short list of moves it may choose from. This replaces the old answer-count
// stage block — the model no longer learns "you are in stage 3 of 7", it learns
// what is known, what is missing, and which moves are legal right now.
//
// Kept compact: every line here is paid on every turn against a free-tier
// token budget, and a bloated prompt is exactly what used to push the room
// onto the scripted bank.

const ACTION_MEANING: Record<string, string> = {
  follow_up: "one deeper question on what they just said",
  clarify: "ask them to make a vague answer concrete, or re-ask more simply after silence",
  challenge: "politely push back, quoting their own words",
  probe_resume: "verify a claim with a question only someone who really did it can answer",
  adjust_difficulty: "same ground, a harder (up) or easier (down) question",
  switch_competency: "move to new ground with a natural transition",
  test_contradiction: "name both statements neutrally and ask them to reconcile — curious, never accusing",
  wrap: "stop assessing and hand them the floor for their questions",
};

/** Only the meanings of the moves actually offered — every line is paid per turn. */
function meaningsFor(moves: ProposedMove[]): string {
  return [...new Set(moves.map((m) => m.action))].map((a) => `${a} = ${ACTION_MEANING[a]}`).join(" · ");
}

function pct(n: number): string {
  return `${Math.round(Math.min(1, n / MIN_COVERAGE) * 100)}%`;
}

function describeMove(m: ProposedMove): string {
  const parts = [`action=${m.action}`];
  if (m.competency) parts.push(`competency=${m.competency}`);
  if (m.target) parts.push(`target=${m.target}`);
  if (m.direction) parts.push(`direction=${m.direction}`);
  return parts.join(" ");
}

function optionLine(o: MoveOption): string {
  return `- ${describeMove(o)} — ${o.reason}`;
}

export function planBlock(s: InterviewState): string {
  const lines: string[] = [];
  const p = s.plan;
  lines.push(
    `INTERVIEW PLAN — internal. Never say any of this aloud; never mention competencies, coverage, moves, claims or scores.`,
    `Role: ${p.roleLabel} · ${p.roundType === "technical" ? "technical" : "HR"} round · ${p.candidate.level}${p.candidate.years ? ` (~${p.candidate.years}y)` : ""}.`,
  );
  if (p.jobDescription?.keywords.length) lines.push(`The job description emphasises: ${p.jobDescription.keywords.slice(0, 8).join(", ")}.`);
  const compLines = p.competencies
    .filter((c) => c.id !== "logistics" || s.phase !== "assessing")
    .map((c) => {
      const l = s.ledger[c.id];
      const state = !l || !l.evidence.length ? "not started" : isAssessed(l) ? "assessed" : `${pct(l.coverage)} known`;
      const diff = l ? DIFFICULTY_LABEL[l.difficulty] : "";
      return `${c.id}${c.required ? "*" : ""} (${c.label}) ${state}, ${diff}`;
    });
  lines.push(`Competencies (* = required): ${compLines.join(" · ")}.`);
  if (s.thread.competency) {
    const l = s.ledger[s.thread.competency];
    lines.push(`Now on: ${competencyLabel(s.thread.competency)} at ${l ? DIFFICULTY_LABEL[l.difficulty] : "intermediate"} difficulty. A strong answer here: ${COMPETENCIES[s.thread.competency]?.rubric.strong ?? "specific and reasoned"}.`);
  }
  const verify = s.claims.filter((c) => c.status === "unverified" || c.status === "weak").slice(0, 4);
  if (verify.length) lines.push(`Claims worth verifying: ${verify.map((c) => `[${c.id}] ${c.text}${c.source === "resume" ? " (resume)" : ""}`).join(" · ")}.`);
  const open = s.contradictions.filter((c) => c.status === "open").slice(0, 2);
  if (open.length) {
    lines.push(`Possible contradictions: ${open.map((c) => `[${c.id}] earlier "${c.quoteA}" vs later "${c.quoteB}"`).join(" · ")}.`);
  }
  if (s.notes.length) lines.push(`Your private notes: ${s.notes.slice(-3).join(" | ")}.`);
  return lines.join("\n");
}

function lastAnswerLine(d: TurnDecision): string {
  const a = d.last;
  if (!a) return "";
  const flags = a.flags.filter((f) => f !== "code");
  const specifics = a.signals.techTerms.length ? `; specifics: ${a.signals.techTerms.slice(0, 4).join(", ")}` : "";
  return `Their last answer read as: ${a.quality}${flags.length ? ` (${flags.join(", ")})` : ""}${specifics}.`;
}

/** The kind-specific instruction — what THIS turn must do. */
export function turnInstruction(s: InterviewState, d: TurnDecision): string {
  switch (d.kind) {
    case "open": {
      const first = s.thread.competency ?? s.plan.competencies[0]?.id;
      const hint = first ? COMPETENCIES[first]?.probes[s.plan.startingDifficulty]?.[0] : undefined;
      return `This turn OPENS the interview. After the greeting, your one opening question should start on ${first ? competencyLabel(first) : "their background"}${hint ? ` — in the spirit of: "${hint}"` : ""}. No ${MOVE_PREFIX} line.`;
    }
    case "code-review":
      return `They just submitted code for the exercise. FIRST check it solves the problem you set; say so plainly if it does not. Then ask ONE question about THEIR code — complexity, an edge case it misses, or a design choice. Never recite code. No ${MOVE_PREFIX} line.`;
    case "hand-over":
      return `You have what you need. STOP assessing: react to their last answer in a clause, then hand them the floor in your own words — what would they like to ask you? No new interview questions. No ${MOVE_PREFIX} line.`;
    case "answer-questions":
      return `They have the floor and just asked you something. ANSWER it specifically from the job brief — nothing invented beyond it. Do not ask them an interview question. No ${MOVE_PREFIX} line.`;
    case "close": {
      const { strongest, weakest } = strongestAndWeakest(s);
      const strong = strongest ? competencyLabel(strongest) : null;
      const weak = weakest ? competencyLabel(weakest) : null;
      return (
        `CLOSE the interview in 2–3 warm sentences${strong ? `: name one specific strength (${strong})` : ""}${weak ? ` and one thing to work on (${weak})` : ""}, ` +
        `then tell them their detailed feedback is ready. Set done true in the control line. No ${MOVE_PREFIX} line.`
      );
    }
    case "coding":
      return "";
    case "move": {
      const opts = d.options.length ? d.options : d.recommended ? [{ ...d.recommended, reason: "recommended" }] : [];
      const lines = [
        `YOUR MOVE — choose exactly ONE of these; they are the only moves allowed right now:`,
        ...opts.slice(0, 6).map(optionLine),
        d.recommended ? `Recommended: ${describeMove(d.recommended)}. Choose differently only if what they just said clearly calls for another listed move.` : "",
        `Moves: ${meaningsFor(opts.slice(0, 6))}.`,
        `FIRST LINE of your reply, exactly: ${MOVE_PREFIX} {"action":"…","competency":"…","target":"…","direction":"…","evidence":"…"} — include only the fields the move needs. ` +
          `"evidence" is a short VERBATIM quote of the candidate, required for challenge and test_contradiction. The ${MOVE_PREFIX} line is never spoken; the spoken words follow it.`,
      ];
      const open = s.contradictions.find((c) => c.id === d.recommended?.target && d.recommended?.action === "test_contradiction");
      if (open) {
        lines.push(
          `If you test the contradiction, sound like this in your own words: "Earlier you mentioned that you ${secondPerson(open.textA)}. Just now you said you ${secondPerson(open.textB)}. Can you clarify exactly what part you owned?"`,
        );
      }
      return lines.filter(Boolean).join("\n");
    }
  }
}

export function buildBrief(s: InterviewState, d: TurnDecision): string {
  return [planBlock(s), lastAnswerLine(d), turnInstruction(s, d)].filter(Boolean).join("\n");
}

/** One line at the point of generation, restating the objective next to the
 * candidate's last words — attention decays with distance from the end. */
export function objectiveLine(s: InterviewState, d: TurnDecision): string {
  switch (d.kind) {
    case "open":
      return "open the interview warmly and ask your first question";
    case "code-review":
      return "review the code they just submitted, then ask one question about it";
    case "hand-over":
      return "stop assessing and hand them the floor for their questions";
    case "answer-questions":
      return "answer the question they just asked you, specifically";
    case "close":
      return "close warmly and finish (done true)";
    default:
      return d.recommended
        ? `make one move from the list (recommended: ${describeMove(d.recommended)}), reacting to what they just said first`
        : "react to what they just said, then make one move from the list";
  }
}
