import { countKeywordHits } from "@/lib/interview/analysis";
import { resumeClaims } from "@/lib/interview/claims";
import { COMPETENCIES, ROLE_FAMILIES, familyOf, roleLabel, type CompetencySpec, type Difficulty } from "@/lib/interview/roles";
import type { Claim, InterviewPlan } from "@/lib/interview/types";
import type { ResumeProfile, RolePreset } from "@/lib/types";

// The interview plan, made once at the start and carried in the session state.
//
// It is what makes two interviews for different roles, resumes and job
// descriptions genuinely different: which competencies must be assessed and how
// much each weighs, what the resume claims that deserves verifying, how hard to
// start, how long to run. Deterministic on purpose — no model call is spent on
// it, and the same inputs always yield the same plan.

const BEHAVIOURAL = new Set(["communication", "ownership", "teamwork", "adaptability", "motivation", "self-awareness", "pressure", "logistics"]);
const MAX_COMPETENCIES = 7;
const MAX_CLAIMS_TO_VERIFY = 6;
export const JOB_DESCRIPTION_MAX_CHARS = 4000;

export interface PlanInput {
  role: RolePreset;
  roundType: "hr" | "technical";
  candidateName: string;
  profile?: ResumeProfile;
  jobDescription?: string;
}

function matchedKeywords(text: string, keywords: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /^[a-z][a-z' -]*[a-z]$/.test(k) ? new RegExp(`(?<![a-z])${escaped}(?![a-z])`).test(lower) : lower.includes(k);
  });
}

export function createPlan(input: PlanInput, nextId: () => string): { plan: InterviewPlan; claims: Claim[] } {
  const family = familyOf(input.role);
  const def = ROLE_FAMILIES[family];
  const technical = input.roundType === "technical" && def.technical.length > 0;
  const specs: CompetencySpec[] = (technical ? def.technical : def.hr).map((s) => ({ ...s }));

  // The job description re-weights the plan: a competency it keeps naming
  // becomes required, and strongly-signalled ground the role did not list is
  // added as optional.
  const jd = (input.jobDescription ?? "").slice(0, JOB_DESCRIPTION_MAX_CHARS).trim();
  const jdKeywords = new Set<string>();
  if (jd) {
    for (const comp of Object.values(COMPETENCIES)) {
      if (BEHAVIOURAL.has(comp.id) === technical) continue;
      const hits = matchedKeywords(jd, comp.keywords);
      if (!hits.length) continue;
      const spec = specs.find((s) => s.id === comp.id);
      if (spec) {
        if (hits.length >= 2 && !comp.unscored) spec.required = true;
        spec.weight = Math.round(spec.weight * (hits.length >= 2 ? 1.25 : 1.1) * 100) / 100;
        hits.forEach((h) => jdKeywords.add(h));
      } else if (hits.length >= 3 && specs.length < MAX_COMPETENCIES) {
        specs.push({ id: comp.id, required: false, weight: 0.8 });
        hits.forEach((h) => jdKeywords.add(h));
      }
    }
  }

  // Resume anchoring: ground the candidate claims to know is worth a little more.
  const skills = input.profile?.skills ?? [];
  const skillText = skills.join(" ");
  for (const spec of specs) {
    const comp = COMPETENCIES[spec.id];
    if (comp && skillText && countKeywordHits(skillText, comp.keywords) > 0) {
      spec.weight = Math.round(spec.weight * 1.1 * 100) / 100;
    }
  }

  const years = input.profile?.yearsOfExperience ?? 0;
  const experienced = Boolean(input.profile?.experienced);
  const requiredSkillMatches = specs.filter((s) => s.required && COMPETENCIES[s.id] && countKeywordHits(skillText, COMPETENCIES[s.id].keywords) > 0).length;
  let difficulty: Difficulty = 1;
  if (experienced && years >= 2) difficulty = 3;
  else if (experienced || requiredSkillMatches >= 2) difficulty = 2;
  if (jd && /\b(senior|lead|staff|principal|[3-9]\+?\s*(?:years|yrs))\b/i.test(jd)) difficulty = Math.min(3, difficulty + 1) as Difficulty;

  const claims = input.profile ? resumeClaims(input.profile, nextId) : [];
  for (const claim of claims) {
    if (claim.competency) continue;
    const subject = claim.tech ?? claim.quote;
    const home = specs.find((s) => COMPETENCIES[s.id] && countKeywordHits(subject, COMPETENCIES[s.id].keywords) > 0);
    if (home) claim.competency = home.id;
  }
  // What the interview sets out to verify: in a technical round, the claimed
  // skills the plan actually assesses, then projects; in HR, projects (they are
  // where ownership and teamwork stories live), then skills.
  const inPlan = (c: Claim) => Boolean(c.competency && specs.some((s) => s.id === c.competency));
  const ordered = [...claims].sort((a, b) => {
    const rank = (c: Claim) => (technical ? (c.kind === "skill" && inPlan(c) ? 0 : c.kind === "ownership" ? 1 : 2) : c.kind === "ownership" ? 0 : inPlan(c) ? 1 : 2);
    return rank(a) - rank(b);
  });

  const plan: InterviewPlan = {
    role: input.role,
    family,
    roleLabel: roleLabel(input.role),
    roundType: technical ? "technical" : "hr",
    candidate: {
      name: input.candidateName,
      level: experienced ? "experienced" : "fresher",
      ...(years ? { years } : {}),
    },
    resume: input.profile
      ? {
          skills: skills.slice(0, 10),
          projects: input.profile.projects.map((p) => p.name).slice(0, 3),
          companies: input.profile.companies.slice(0, 3),
        }
      : null,
    jobDescription: jd ? { keywords: [...jdKeywords].slice(0, 12) } : null,
    competencies: specs.slice(0, MAX_COMPETENCIES).map((s) => ({
      id: s.id,
      label: COMPETENCIES[s.id]?.label ?? s.id,
      required: s.required,
      weight: s.weight,
    })),
    claimsToVerify: ordered.filter((c) => c.kind !== "skill" || inPlan(c)).slice(0, MAX_CLAIMS_TO_VERIFY).map((c) => c.id),
    startingDifficulty: difficulty,
    style: technical ? "technical-deep-dive" : "conversational-behavioural",
    targetMinutes: technical ? 20 : 12,
    maxAnswers: technical ? 16 : 14,
    coding: technical,
  };
  return { plan, claims: claims.filter((c) => plan.claimsToVerify.includes(c.id) || c.kind === "skill").slice(0, 10) };
}
