import { isAssessed, scoreOf } from "@/lib/interview/coverage";
import { COMPETENCIES, competencyLabel, DIFFICULTY_LABEL } from "@/lib/interview/roles";
import type { CompetencyReport, InterviewState, ReadinessReport, Verdict } from "@/lib/interview/types";
import { isNoAnswer } from "@/lib/llm/parse";
import type { HistoryEntry } from "@/lib/types";

// The readiness report — computed from the verified state, never from anything
// the client sends. Deterministic: the same interview always produces the same
// verdict, and every number in it traces back to evidence in the transcript.
// A competency without enough verified evidence says "not assessed" instead of
// inventing a score.

const MIN_CONFIDENCE = 0.3;
const SERIOUS_CONTRADICTIONS = new Set(["scope", "role", "resume"]);

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function verdictFor(overall: number | null, minRequired: number | null, requiredRatio: number, seriousContradictions: number): Verdict {
  if (overall === null) return "NOT READY";
  let v: Verdict = overall >= 7.5 ? "READY" : overall >= 6 ? "ALMOST READY" : overall >= 4.5 ? "NEEDS PRACTICE" : "NOT READY";
  const rank: Verdict[] = ["NOT READY", "NEEDS PRACTICE", "ALMOST READY", "READY"];
  const cap = (max: Verdict) => {
    if (rank.indexOf(v) > rank.indexOf(max)) v = max;
  };
  if (v === "READY" && (requiredRatio < 1 || (minRequired !== null && minRequired < 5.5))) cap("ALMOST READY");
  if (minRequired !== null && minRequired < 4) cap("NEEDS PRACTICE");
  if (requiredRatio < 0.6) cap("NEEDS PRACTICE");
  if (seriousContradictions > 0) cap("ALMOST READY");
  return v;
}

export function buildReadinessReport(s: InterviewState, history: HistoryEntry[], now: number): ReadinessReport {
  const comps = s.plan.competencies.filter((c) => !COMPETENCIES[c.id]?.unscored);
  const competencies: CompetencyReport[] = comps.map((c) => {
    const ledger = s.ledger[c.id];
    const { score, confidence } = ledger ? scoreOf(ledger) : { score: null, confidence: 0 };
    const assessed = Boolean(ledger && score !== null && confidence >= MIN_CONFIDENCE && (isAssessed(ledger) || ledger.evidence.length >= 1));
    const evidence = ledger
      ? [...ledger.evidence]
          .filter((e) => e.quote && e.weight >= 0.5)
          .sort((a, b) => Number(b.source === "model") - Number(a.source === "model") || (b.score ?? 0) - (a.score ?? 0))
          .map((e) => e.quote)
          .filter((q, i, all) => all.indexOf(q) === i)
          .slice(0, 3)
      : [];
    return {
      id: c.id,
      label: c.label,
      required: c.required,
      score: assessed ? score : null,
      coverage: Math.round(Math.min(1, ledger?.coverage ?? 0) * 100) / 100,
      confidence: assessed ? confidence : 0,
      status: assessed ? "assessed" : "not-assessed",
      evidence,
      ...(ledger?.strength ? { strength: ledger.strength } : {}),
      ...(ledger?.weakness ? { weakness: ledger.weakness } : {}),
    };
  });

  const scored = competencies.filter((c) => c.score !== null);
  const weightOf = (id: string) => comps.find((c) => c.id === id)?.weight ?? 1;
  const totalWeight = scored.reduce((t, c) => t + weightOf(c.id) * c.confidence, 0);
  const overall = totalWeight > 0 ? round1(scored.reduce((t, c) => t + (c.score ?? 0) * weightOf(c.id) * c.confidence, 0) / totalWeight) : null;
  const required = competencies.filter((c) => c.required);
  const requiredAssessed = required.filter((c) => c.status === "assessed");
  const requiredRatio = required.length ? requiredAssessed.length / required.length : 1;
  const minRequired = requiredAssessed.length ? Math.min(...requiredAssessed.map((c) => c.score ?? 10)) : null;
  const serious = s.contradictions.filter((c) => SERIOUS_CONTRADICTIONS.has(c.kind) && c.status !== "resolved").length;
  const verdict = verdictFor(overall, minRequired, requiredRatio, serious);
  const confidence = required.length ? round1(required.reduce((t, c) => t + c.confidence, 0) / required.length) : round1(scored.reduce((t, c) => t + c.confidence, 0) / Math.max(1, scored.length));

  const ranked = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const strongest = ranked.filter((c) => (c.score ?? 0) >= 6).slice(0, 2).map((c) => c.id);
  const weakest = [...ranked]
    .reverse()
    .filter((c) => (c.score ?? 10) < 6.5 && !strongest.includes(c.id))
    .slice(0, 2)
    .map((c) => c.id);
  const unassessedRequired = required.filter((c) => c.status === "not-assessed").map((c) => c.id);

  const struggled = s.struggles.slice(-6).map((st) => {
    const answer = history[st.turn]?.text;
    return {
      question: st.question || "(the question before this answer)",
      competency: st.competency,
      kind: st.kind === "silent" ? "no answer" : st.kind === "tap-out" ? "said they didn't know" : "stayed vague after being asked for specifics",
      ...(answer && !isNoAnswer(answer) ? { quote: answer.slice(0, 160) } : {}),
    };
  });

  const resumeFindings = s.claims
    .filter((c) => c.source === "resume" || (c.kind === "ownership" && c.probes > 0))
    .slice(0, 8)
    .map((c) => {
      const status =
        c.status === "supported" ? "verified" : c.status === "weak" ? "unconvincing" : c.status === "contradicted" ? "contradicted" : c.probes > 0 ? "unverified" : "not discussed";
      const detail =
        status === "verified"
          ? "backed up with specifics in your answers"
          : status === "unconvincing"
            ? "probed, but the answers stayed vague"
            : status === "contradicted"
              ? "contradicted by something you said later"
              : status === "unverified"
                ? "asked about, but not yet backed up"
                : "never came up — expect it in a real interview";
      return { claim: c.source === "resume" ? c.text.replace(/^lists /, "").replace(/ on the resume$/, "") : c.text, status, detail, ...(c.evidence[0] ? { quote: c.evidence[0] } : {}) };
    });

  const contradictions = s.contradictions.map((c) => ({
    earlier: c.quoteA,
    later: c.quoteB,
    turnEarlier: c.turnA,
    turnLater: c.turnB,
    status: c.status === "open" ? "not raised" : c.status,
    explanation: c.explanation,
  }));

  const focusIds = [...new Set([...unassessedRequired, ...weakest])];
  const studyTopics = [...new Set(focusIds.flatMap((id) => COMPETENCIES[id]?.study.slice(0, 2) ?? []))].slice(0, 8);
  for (const c of competencies) {
    if (c.weakness?.startsWith("Factual slip") && studyTopics.length < 9) studyTopics.push(`Revisit: ${c.weakness.replace(/^Factual slip:\s*/, "")}`);
  }

  const practicePlan: string[] = [];
  const weakestRequired = weakest.find((id) => required.some((r) => r.id === id)) ?? unassessedRequired[0];
  if (weakestRequired) {
    const q = s.struggles.find((st) => st.competency === weakestRequired)?.question;
    const study = COMPETENCIES[weakestRequired]?.study[0];
    practicePlan.push(
      `This week, work on ${competencyLabel(weakestRequired).toLowerCase()}${study ? `: ${study.charAt(0).toLowerCase()}${study.slice(1)}` : ""}.${q ? ` Then answer "${q}" out loud in under two minutes.` : ""}`,
    );
  }
  if (serious > 0) {
    practicePlan.push("Rehearse an accurate ownership story for your main project: exactly which parts you built, which your team did — so your resume and your answers always match.");
  }
  const vagueCount = s.struggles.filter((st) => st.kind === "vague").length + Object.values(s.ledger).reduce((t, l) => t + l.evidence.filter((e) => e.quality === "vague" && e.weight >= 1).length, 0);
  if (vagueCount >= 2) {
    practicePlan.push("Practise the situation → action → result shape on two real stories; every answer should carry one number, tool or decision you made.");
  }
  const tapped = [...new Set(s.struggles.filter((st) => st.kind === "tap-out" && st.competency).map((st) => st.competency!))].filter((id) => id !== weakestRequired);
  for (const id of tapped.slice(0, 1)) {
    const l = s.ledger[id];
    practicePlan.push(`Close the gap in ${competencyLabel(id).toLowerCase()} at ${l ? DIFFICULTY_LABEL[l.difficulty] : "foundation"} level before your next round: ${COMPETENCIES[id]?.study[0] ?? "review the fundamentals"}.`);
  }
  const unverifiedResume = s.claims.filter((c) => c.source === "resume" && c.status !== "supported").slice(0, 2);
  if (unverifiedResume.length) {
    practicePlan.push(`Prepare a two-minute proof for what your resume claims: ${unverifiedResume.map((c) => c.quote).join(" and ")} — what you built, a decision you made, and one problem you solved.`);
  }
  if (strongest[0]) {
    practicePlan.push(`Keep leading with ${competencyLabel(strongest[0]).toLowerCase()} — it was your strongest area; open "tell me about yourself" with it.`);
  }

  const nextFocus = [
    ...focusIds.map((id) => competencyLabel(id)),
    ...unverifiedResume.map((c) => `Verify your ${c.quote} experience`),
  ].slice(0, 5);
  if (!nextFocus.length && overall !== null) nextFocus.push("A harder round: raise the difficulty on your strongest competencies");

  const strongLabel = strongest[0] ? competencyLabel(strongest[0]) : null;
  const weakLabel = weakestRequired ? competencyLabel(weakestRequired) : weakest[0] ? competencyLabel(weakest[0]) : null;
  const summary =
    overall === null
      ? "There wasn't enough verified evidence to score this round — answer a few questions in depth next time and the report will fill in."
      : `${verdict.charAt(0)}${verdict.slice(1).toLowerCase()} — ${overall}/10 across ${scored.length} assessed ${scored.length === 1 ? "competency" : "competencies"}.` +
        `${strongLabel ? ` Strongest: ${strongLabel}.` : ""}${weakLabel ? ` Focus next: ${weakLabel}.` : ""}`;

  return {
    version: 1,
    verdict,
    overall,
    confidence,
    summary,
    role: s.plan.role,
    roleLabel: s.plan.roleLabel,
    roundType: s.plan.roundType,
    competencies,
    strongest,
    weakest,
    struggled,
    resumeFindings,
    contradictions,
    studyTopics,
    practicePlan: practicePlan.slice(0, 5),
    nextFocus,
    generatedAt: now,
  };
}
