import type { RolePreset } from "@/lib/types";
import { legacyRoleOf } from "@/lib/interview/roles";

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

export const COMPANY_BRIEFS: Partial<Record<RolePreset, CompanyBrief>> & Record<"general", CompanyBrief> = {
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
  fullstack: {
    ...BASE,
    team: "a six-person product squad that owns one feature end to end, database to UI",
    ships: "the self-serve onboarding flow for small-business customers",
    stack: "TypeScript everywhere — Next.js on the front, Node and Postgres behind it, deployed on AWS",
    firstMonths: "a paired feature across the API and the UI in month one, then your own small feature",
    mentoring: "a senior full-stack engineer as your buddy and a weekly one-to-one",
    hard: "you context-switch between SQL, APIs and CSS in the same afternoon",
    next: BASE.next,
  },
  backend: {
    ...BASE,
    team: "the orders platform team, seven engineers running a dozen services",
    ships: "the order, inventory and notification APIs every client app depends on",
    stack: "Java 17 and Spring Boot, Postgres, Redis, Kafka, Kubernetes",
    firstMonths: "fixing a real bug in a service in week two, then an endpoint of your own with review",
    mentoring: "a named senior engineer reviews all your PRs for the first quarter",
    hard: "latency budgets are strict and a slow query shows up on a dashboard within minutes",
    next: BASE.next,
  },
  python: {
    ...BASE,
    team: "the internal automation team, five engineers",
    ships: "Python services and scripts that remove manual work for the operations staff",
    stack: "Python 3, FastAPI and Django, Postgres, Celery, deployed with Docker",
    firstMonths: "automating one real manual workflow end to end in your first six weeks",
    mentoring: "pair programming twice a week with a senior Python engineer",
    hard: "some legacy scripts have no tests, so you add them before you change anything",
    next: BASE.next,
  },
  "data-analyst": {
    ...BASE,
    team: "the analytics team, four analysts embedded with product and sales",
    ships: "weekly business dashboards and the analysis behind pricing and growth decisions",
    stack: "SQL on Postgres and BigQuery, Python with pandas, and Power BI dashboards",
    firstMonths: "owning one recurring dashboard, then a small analysis presented to a product manager",
    mentoring: "a lead analyst reviews every query and deck you ship for the first quarter",
    hard: "stakeholders want answers in hours while the data needs cleaning first",
    next: BASE.next,
  },
  devops: {
    ...BASE,
    team: "the platform team, five engineers supporting forty developers",
    ships: "the CI/CD pipelines, Kubernetes clusters and monitoring every team deploys through",
    stack: "AWS, Kubernetes, Terraform, GitHub Actions, Prometheus and Grafana",
    firstMonths: "improving one pipeline, then shadowing on-call for a month before joining the rotation",
    mentoring: "a senior SRE pairs with you on every production change at first",
    hard: "on-call is real — an alert at 2am means someone's deploy is blocked",
    next: BASE.next,
  },
  qa: {
    ...BASE,
    team: "the quality engineering group, six testers working inside product squads",
    ships: "the regression suites and release sign-off for the customer web and mobile apps",
    stack: "Selenium and Playwright with Java and TypeScript, Postman for APIs, Jenkins pipelines",
    firstMonths: "manual exploratory testing of one feature, then automating its regression cases",
    mentoring: "a QA lead reviews your test plans and bug reports for the first quarter",
    hard: "flaky tests erode trust fast, so fixing them is part of the job",
    next: BASE.next,
  },
  "ai-ml": {
    ...BASE,
    team: "the applied ML team, five engineers shipping models into the product",
    ships: "the search ranking model and an LLM-based support assistant",
    stack: "Python, PyTorch, scikit-learn, a vector database, and model serving on Kubernetes",
    firstMonths: "reproducing an existing model's evaluation, then improving one feature of it",
    mentoring: "a senior ML engineer reviews your experiments weekly",
    hard: "a model that wins offline often loses in production, and you have to find out why",
    next: BASE.next,
  },
  "hr-behavioural": {
    ...BASE,
    team: "a cross-functional graduate programme, twenty trainees rotating across teams",
    ships: "projects in operations, customer success and product during three rotations",
    stack: "whatever the rotation needs — the programme values communication and ownership over tools",
    firstMonths: "a two-week induction, then your first rotation with a named manager",
    mentoring: "a programme mentor for the whole year, plus a manager per rotation",
    hard: "every rotation starts from zero, so you have to learn fast and ask a lot",
    next: BASE.next,
  },
};

export function companyBriefFor(role: RolePreset | string): CompanyBrief {
  return COMPANY_BRIEFS[role as RolePreset] ?? COMPANY_BRIEFS[legacyRoleOf(role)] ?? COMPANY_BRIEFS.general;
}

/** The prompt block. Compact on purpose — see the token note above. Anything
 * added here is paid on every turn of every interview. */
export function companyBriefBlock(role: RolePreset): string {
  const b = companyBriefFor(role);
  return (
    `THE JOB (yours to give — answer specifically when asked, volunteer a piece when it fits, invent nothing beyond it; ` +
    `if asked something not here, say you would have to check). ${b.company}. Team: ${b.team}, shipping ${b.ships}. ` +
    `Stack: ${b.stack}. First months: ${b.firstMonths}. Support: ${b.mentoring}. Genuinely hard: ${b.hard}. Process: ${b.next}.`
  );
}
