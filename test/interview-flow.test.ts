import { describe, expect, it } from "vitest";
import {
  CODING_QUESTION_SLOT,
  composeResumeGreeting,
  computeNextTurn,
  DEEP_PROBES,
  effectiveQuestions,
  MAX_FOLLOWUPS_PER_QUESTION,
  projectDiveQuestions,
  QUESTIONS_PER_INTERVIEW,
} from "@/lib/llm/interview-flow";
import { EXPERIENCED_HR_QUESTIONS, FRESHER_HR_QUESTIONS, HR_QUESTIONS } from "@/lib/fixtures/hr-questions";
import { CODING_INTRO, DSA_QUESTIONS, technicalBank } from "@/lib/fixtures/technical-questions";
import { buildPrompt, claudeCliProvider } from "@/lib/llm/claude-cli";
import type { HistoryEntry, InterviewerTurn, InterviewRequest, ResumeProfile, RolePreset } from "@/lib/types";

const LONG_ANSWER =
  "In my final year project I led a team of four, we had a conflict about the database choice, " +
  "and I organized a spike to compare both options with real data, then we agreed on the result and " +
  "shipped on time, which taught me to argue with evidence instead of opinions and learn from my team.";

function playThrough(
  answer: string,
  roundType: "hr" | "technical" = "hr",
  role: RolePreset = "general",
  profile?: ResumeProfile,
) {
  const history: HistoryEntry[] = [];
  const turns: InterviewerTurn[] = [];
  for (let guard = 0; guard < 40; guard++) {
    // The same profile on every call — the readPosition contract.
    const turn = computeNextTurn("hari", history, roundType, role, profile);
    turns.push(turn);
    history.push({ speaker: "interviewer", text: turn.text });
    if (turn.done) break;
    history.push({ speaker: "candidate", text: answer });
  }
  return { turns, history };
}

const FRESHER_PROFILE: ResumeProfile = {
  name: "Sai Gogineni",
  experienced: false,
  companies: [],
  skills: ["DSA", "Java", "React", "Full Stack"],
  projects: [
    { name: "Placement Day Simulator", summary: "Voice-first AI mock interviewer with speculative TTS" },
    { name: "Campus Cart", summary: "Full stack grocery app for hostels" },
  ],
  education: "B.Tech CSE, JNTU",
  highlight: "Cut interviewer response latency by 40% with speculative execution",
};

const EXPERIENCED_PROFILE: ResumeProfile = {
  name: "RAHUL VERMA",
  experienced: true,
  yearsOfExperience: 3,
  companies: ["Infosys Technologies", "Wipro Solutions"],
  skills: ["Java", "Spring Boot", "SQL"],
  projects: [{ name: "Payment Reconciliation Engine", summary: "Cut settlement mismatches by 40%" }],
  highlight: "Cut settlement mismatches by 40% across 3 banks",
};

describe("interview flow", () => {
  it("greets first, asks 5 questions, wraps up — no follow-ups for strong answers", () => {
    const { turns } = playThrough(LONG_ANSWER);
    expect(turns[0].type).toBe("greeting");
    expect(turns.filter((t) => t.type === "question").length).toBe(QUESTIONS_PER_INTERVIEW);
    expect(turns[turns.length - 1].type).toBe("wrapup");
  });

  it("chains up to 2 follow-ups per question on thin answers, never a third", () => {
    const { turns } = playThrough("I don't know really.");
    const followups = turns.filter((t) => t.type === "followup");
    // Every question earns the full chain: canned follow-up + deep probe.
    expect(followups.length).toBe(QUESTIONS_PER_INTERVIEW * MAX_FOLLOWUPS_PER_QUESTION);
    // Never more than the chain per question index.
    const perQuestion = new Map<number, number>();
    for (const f of followups) perQuestion.set(f.questionIndex, (perQuestion.get(f.questionIndex) ?? 0) + 1);
    for (const count of perQuestion.values()) expect(count).toBeLessThanOrEqual(MAX_FOLLOWUPS_PER_QUESTION);
    expect(turns[turns.length - 1].type).toBe("wrapup");
  });

  it("second-level probes keep the parent questionIndex (scoring identity)", () => {
    const { turns } = playThrough("I don't know really.");
    let currentQuestion = 0;
    for (const t of turns) {
      if (t.type === "question") currentQuestion = t.questionIndex;
      if (t.type === "followup") expect(t.questionIndex).toBe(currentQuestion);
    }
  });

  it("deep probes never collide with fixture question or follow-up text", () => {
    const fixtureTexts = new Set<string>();
    for (const q of HR_QUESTIONS) {
      fixtureTexts.add(q.text);
      fixtureTexts.add(q.followup);
    }
    for (const role of ["general", "java-sde-fresher", "frontend-fresher"] as const) {
      for (const q of technicalBank(role)) {
        fixtureTexts.add(q.text);
        fixtureTexts.add(q.followup);
      }
    }
    for (const probe of [...DEEP_PROBES.hr, ...DEEP_PROBES.technical]) {
      expect(fixtureTexts.has(probe)).toBe(false);
    }
  });

  it("picks deep probes deterministically — same session, same probes", () => {
    const a = playThrough("I don't know really.");
    const b = playThrough("I don't know really.");
    expect(a.turns.map((t) => t.text)).toEqual(b.turns.map((t) => t.text));
  });

  it("is deterministic for the same candidate name", () => {
    const a = computeNextTurn("hari", [{ speaker: "interviewer", text: "greeting placeholder" }]);
    const b = computeNextTurn("hari", [{ speaker: "interviewer", text: "greeting placeholder" }]);
    expect(a.text).toBe(b.text);
  });

  it("terminates even on empty answers (no infinite follow-up loop)", () => {
    const { turns } = playThrough("(no answer)");
    expect(turns[turns.length - 1].type).toBe("wrapup");
    // greeting + 5 × (question + 2 follow-ups) + wrapup = 17 turns max.
    expect(turns.length).toBeLessThan(20);
  });

  it("keeps the coding slot at #3 in technical rounds, with no follow-ups on it", () => {
    const { turns } = playThrough("I don't know really.", "technical", "java-sde-fresher");
    const coding = turns.filter((t) => t.coding);
    expect(coding.length).toBe(1);
    expect(coding[0].questionIndex).toBe(CODING_QUESTION_SLOT);
    const codingFollowups = turns.filter((t) => t.type === "followup" && t.questionIndex === CODING_QUESTION_SLOT);
    expect(codingFollowups.length).toBe(0);
    expect(turns[turns.length - 1].type).toBe("wrapup");
  });

  it("effectiveQuestions puts the coding entry at the slot with an empty followup", () => {
    const qs = effectiveQuestions("hari", "technical", "general");
    expect(qs[CODING_QUESTION_SLOT - 1].coding).toBe(true);
    expect(qs[CODING_QUESTION_SLOT - 1].followup).toBe("");
  });
});

describe("resume-profile-driven flow", () => {
  it("fresher profile selects the fresher HR bank plus 2 project dives at slots 2-3", () => {
    const qs = effectiveQuestions("hari", "hr", "general", FRESHER_PROFILE);
    expect(qs.length).toBe(QUESTIONS_PER_INTERVIEW);
    expect(qs[1].text).toBe("Walk me through Placement Day Simulator — what was the hardest part?");
    expect(qs[2].text).toBe("Walk me through Campus Cart — what was the hardest part?");
    const fresherTexts = new Set(FRESHER_HR_QUESTIONS.map((q) => q.text));
    for (const q of [qs[0], qs[3], qs[4]]) expect(fresherTexts.has(q.text)).toBe(true);
  });

  it("experienced profile selects the experienced HR bank", () => {
    const qs = effectiveQuestions("hari", "hr", "general", EXPERIENCED_PROFILE);
    const expTexts = new Set(EXPERIENCED_HR_QUESTIONS.map((q) => q.text));
    const diveTexts = new Set(projectDiveQuestions(EXPERIENCED_PROFILE).map((q) => q.text));
    for (const q of qs) expect(expTexts.has(q.text) || diveTexts.has(q.text)).toBe(true);
    expect(qs.some((q) => diveTexts.has(q.text))).toBe(true);
  });

  it("readPosition recognizes generated project-dive questions — full session terminates", () => {
    const { turns } = playThrough(LONG_ANSWER, "hr", "general", FRESHER_PROFILE);
    expect(turns.filter((t) => t.type === "question").length).toBe(QUESTIONS_PER_INTERVIEW);
    expect(turns.some((t) => t.text.includes("Placement Day Simulator"))).toBe(true);
    expect(turns[turns.length - 1].type).toBe("wrapup");
  });

  it("project dives earn the follow-up chain on thin answers, still bounded", () => {
    const { turns } = playThrough("I don't know really.", "hr", "general", FRESHER_PROFILE);
    const diveFollowup = turns.find((t) => t.type === "followup" && t.text.includes("Placement Day Simulator"));
    expect(diveFollowup).toBeDefined();
    expect(turns[turns.length - 1].type).toBe("wrapup");
    expect(turns.length).toBeLessThan(20);
  });

  it("is deterministic with a profile: same name + profile, same session", () => {
    const a = playThrough("I don't know really.", "hr", "general", EXPERIENCED_PROFILE);
    const b = playThrough("I don't know really.", "hr", "general", EXPERIENCED_PROFILE);
    expect(a.turns.map((t) => t.text)).toEqual(b.turns.map((t) => t.text));
  });

  it("technical round is DSA + coding only — no project dives, coding slot at #3", () => {
    const { turns } = playThrough(LONG_ANSWER, "technical", "java-sde-fresher", FRESHER_PROFILE);
    const coding = turns.filter((t) => t.coding);
    expect(coding.length).toBe(1);
    expect(coding[0].questionIndex).toBe(CODING_QUESTION_SLOT);
    // User directive: technical asks ONLY DSA + coding — dives stay in HR.
    expect(turns.some((t) => t.text.includes("Placement Day Simulator"))).toBe(false);
    const dsaTexts = new Set(DSA_QUESTIONS.map((q) => q.text));
    const mains = turns.filter((t) => t.type === "question" && !t.coding && !t.text.startsWith(CODING_INTRO));
    expect(mains.some((t) => dsaTexts.has(t.text))).toBe(true);
    expect(turns[turns.length - 1].type).toBe("wrapup");
  });

  it("HR canon banks and dives never collide with probes or each other (readPosition identity)", () => {
    const all = [
      ...HR_QUESTIONS,
      ...FRESHER_HR_QUESTIONS,
      ...EXPERIENCED_HR_QUESTIONS,
      ...projectDiveQuestions(FRESHER_PROFILE),
      ...projectDiveQuestions(EXPERIENCED_PROFILE),
    ];
    const texts = all.flatMap((q) => [q.text, q.followup]);
    expect(new Set(texts).size).toBe(texts.length);
    for (const probe of [...DEEP_PROBES.hr, ...DEEP_PROBES.technical]) {
      expect(texts.includes(probe)).toBe(false);
    }
  });
});

describe("deterministic resume greeting (single source)", () => {
  it("greets an experienced candidate with years and most recent company", () => {
    const g = composeResumeGreeting("hari", EXPERIENCED_PROFILE);
    expect(g).toContain("Hi Rahul");
    expect(g).toContain("I went through your resume");
    expect(g).toContain("3 years at Infosys Technologies");
    expect(g.split(/[.!?]+\s/).length).toBeLessThanOrEqual(3); // 2 sentences + terminal split slack
  });

  it("greets a fresher with a highlight compliment and a project opener", () => {
    const g = composeResumeGreeting("hari", FRESHER_PROFILE);
    expect(g).toContain("Hi Sai");
    expect(g).toContain("caught my eye");
    expect(g).toContain("project that taught you the most");
  });

  it("computeNextTurn uses the composer for the greeting when a profile exists", () => {
    const turn = computeNextTurn("hari", [], "hr", "general", EXPERIENCED_PROFILE);
    expect(turn.type).toBe("greeting");
    expect(turn.text).toBe(composeResumeGreeting("hari", EXPERIENCED_PROFILE));
  });

  it("falls back through project name and skills when there is no highlight", () => {
    const noHighlight: ResumeProfile = { experienced: false, companies: [], skills: ["Java", "DSA"], projects: [] };
    const g = composeResumeGreeting("priya sharma", noHighlight);
    expect(g).toContain("Hi priya");
    expect(g).toContain("Java and DSA");
  });
});

describe("claude-cli provider (scripted paths, no CLI spawned)", () => {
  it("greeting turn is deterministic and fires onText exactly once with the full text", async () => {
    const req: InterviewRequest = {
      role: "general",
      roundType: "hr",
      candidateName: "hari",
      profile: EXPERIENCED_PROFILE,
      history: [],
    };
    const seen: string[] = [];
    const turn = await claudeCliProvider.nextTurn(req, { onText: (t) => seen.push(t) });
    expect(turn.type).toBe("greeting");
    expect(turn.text).toBe(composeResumeGreeting("hari", EXPERIENCED_PROFILE));
    expect(seen).toEqual([turn.text]);
  });

  it("keeps the prompt head under the latency budget for a maximal profile", () => {
    const req: InterviewRequest = {
      role: "java-sde-fresher",
      roundType: "hr",
      candidateName: "Rahul",
      profile: {
        name: "RAHUL VERMA",
        experienced: true,
        yearsOfExperience: 3,
        companies: ["Infosys Technologies", "Wipro Solutions", "Tata Consultancy Services", "Mindtree Labs"],
        skills: ["DSA", "Java", "Python", "Full Stack", "React", "Node.js", "SQL", "PostgreSQL", "MongoDB", "REST APIs"],
        projects: [
          { name: "Payment Reconciliation Engine", summary: "Cut settlement mismatches by 40% across 3 banks with an idempotent ledger" },
          { name: "Campus Cart", summary: "Full stack grocery app for hostels using React and Node.js" },
          { name: "Note Ninja", summary: "Markdown note app with offline sync and conflict resolution" },
        ],
        education: "B.Tech, NIT Warangal",
        highlight: "Cut settlement mismatches by 40% across 3 banks",
      },
      codeLanguage: "java",
      history: [{ speaker: "interviewer", text: "Hi." }, { speaker: "candidate", text: "Hello." }],
    };
    const prompt = buildPrompt(req);
    const head = prompt.slice(0, prompt.indexOf("Interview so far:"));
    // ~1600-char budget with slack for maximal profiles — the transcript grows,
    // this must not.
    expect(head.length).toBeLessThanOrEqual(1700);
    expect(prompt).toContain("@@CTRL");
    expect(prompt).toContain("CANDIDATE RESUME PROFILE");
    expect(prompt).not.toContain("<<<RESUME");
  });
});
