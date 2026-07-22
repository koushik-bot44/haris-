import type { RolePreset } from "@/lib/types";

// What Haris knows about the job it is interviewing you for.
//
// An interview is two-sided because BOTH people hold information the other
// wants. Until now information only ever flowed one way: Haris asked, you
// answered, and if you asked "what would I actually be doing?" it had nothing
// true to say. Fortune's reporting on AI interviewers names exactly this as a
// top candidate complaint — "AI unable to answer candidate questions about
// company culture or values" — and it is the literal shape of the "one-sided"
// problem.
//
// So Haris gets a brief. It is openly a simulated employer (Haris says it is an
// AI running a practice interview; inventing a real company to lie about would
// undo that). The details are specific on purpose: vague answers to candidate
// questions are worse than none, because the candidate is practising judging
// an employer, and there is nothing to judge in "we have a great culture".
//
// Kept short deliberately — every character here is paid on every turn against
// a 12k-tokens-per-minute budget, and going over drops the interview to the
// fixture bank.

export interface CompanyBrief {
  company: string;
  team: string;
  ships: string;
  stack: string;
  firstMonths: string;
  mentoring: string;
  hard: string;
  next: string;
}

const BASE = {
  company: "Meridian, a mid-size product company (a simulated employer for this practice round)",
  next: "two rounds after this, then a decision inside a week",
};

export const COMPANY_BRIEFS: Record<RolePreset, CompanyBrief> = {
  general: {
    ...BASE,
    team: "a nine-person product team, three of them freshers hired last year",
    ships: "internal tools the operations staff use every day",
    stack: "Java and Spring on the back end, React on the front, Postgres, deployed on AWS",
    firstMonths: "six weeks of structured training, then small bug-fix tickets on a real service with a reviewer on every PR",
    mentoring: "every fresher gets a named buddy for the first six months and a weekly one-to-one",
    hard: "the codebase is ten years old in places and the documentation has not kept up",
    next: BASE.next,
  },
  "java-sde-fresher": {
    ...BASE,
    team: "the payments platform team, six engineers, two hired straight from campus",
    ships: "the settlement and reconciliation services — money moving, so correctness matters more than speed",
    stack: "Java 17, Spring Boot, Kafka, Postgres, Kubernetes",
    firstMonths: "you shadow a reconciliation flow end to end, then own a small consumer with review",
    mentoring: "a senior engineer pairs with you two afternoons a week for the first quarter",
    hard: "on-call starts at month six, and debugging a stuck Kafka consumer at 2am is genuinely hard",
    next: BASE.next,
  },
  "frontend-fresher": {
    ...BASE,
    team: "a four-person front-end team inside a larger product group",
    ships: "the customer-facing dashboard — about forty thousand people use it daily",
    stack: "React and TypeScript, Next.js, a design system we maintain ourselves",
    firstMonths: "component work against real designs, then a full feature by month four",
    mentoring: "design reviews twice a week, and a front-end lead who reviews every PR at the start",
    hard: "the design system is mid-migration, so you will hit two ways of doing the same thing",
    next: BASE.next,
  },
};

/** The prompt block. Compact on purpose — see the token note above. Anything
 * added here is paid on every turn of every interview. */
export function companyBriefBlock(role: RolePreset): string {
  const b = COMPANY_BRIEFS[role] ?? COMPANY_BRIEFS.general;
  return (
    `THE JOB (yours to give — answer specifically when asked, volunteer a piece when it fits, invent nothing beyond it; ` +
    `if asked something not here, say you would have to check). ${b.company}. Team: ${b.team}, shipping ${b.ships}. ` +
    `Stack: ${b.stack}. First months: ${b.firstMonths}. Support: ${b.mentoring}. Genuinely hard: ${b.hard}. Process: ${b.next}.`
  );
}
