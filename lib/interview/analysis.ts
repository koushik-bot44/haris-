import { COMPETENCIES } from "@/lib/interview/roles";
import type { AnswerAnalysis, AnswerFlag, AnswerQuality, AnswerSignals, InterviewPlan } from "@/lib/interview/types";
import { isNoAnswer, looksLikeCandidateQuestion } from "@/lib/llm/parse";

// Deterministic reading of one answer: how much real substance it carries, which
// competencies it is evidence for, and what an interviewer would notice about it
// (a hedge, an overclaim, a tap-out, a question back).
//
// This runs on every turn with zero model calls, so a strong and a weak answer
// have different consequences even when the background model is rate-limited or
// down. The model's analysis, when it arrives, refines the same ledger — it
// never replaces this path's job of keeping the interview moving.
//
// Calibrated on SPOKEN answers. The first version keyed "specific" on digits
// and a short buzzword list, so a complete spoken answer with no numbers in it
// ("I did the whole backend part, the login and listing pages talk to my APIs,
// my friend did the design side") was read as vague — and every downstream
// move (clarify, challenge, probe the resume claim again) then asked the
// candidate to repeat what they had just said. Speech has few digits and few
// buzzwords; it has verbs of ownership, causes, and named things.

const HEDGE_RE = /\b(i think|i guess|maybe|probably|kind of|sort of|not sure|i believe|perhaps|i suppose|something like|more or less|i feel like)\b/gi;
const TAP_OUT_RE =
  /\b(i\s+(?:really\s+|honestly\s+)?don'?t\s+know|i\s+do\s+not\s+know|no\s+idea|no\s+clue|not\s+sure\s+(?:about\s+)?(?:that|this|how|what|why)|i\s+(?:haven'?t|have\s+not|never)\s+(?:worked|used|done|learned|learnt|studied|come\s+across)|i\s+can'?t\s+(?:recall|remember|say)|i'?m\s+not\s+(?:familiar|aware|sure|fully\s+sure|really\s+sure)|(?:can|could)\s+(?:we|i)\s+skip|i\s+(?:forgot|don'?t\s+remember)|i\s+(?:pass|give\s+up)|i\s+have\s+not\s+used\s+it)\b/i;
const CAUSAL_RE =
  /\b(because|because of|since we|since i|so that|so i|so we|so the|so it|so they|so only|so there|which meant|that's why|which is why|therefore|trade-?offs?|instead of|rather than|the reason|the idea was|the problem was|the issue was|what happened was|turned out|ended up|as a result|in order to|to avoid|to make sure|so basically|that way|otherwise|which is|which means|the main thing was)\b/i;
const EXAMPLE_RE =
  /\b(for example|for instance|e\.g\.|such as|one time|like when|there was a time|there was one|in (?:my|our|that|the|this) (?:project|internship|final[- ]year|previous|college|team|last)|when (?:i|we) (?:was|were|built|worked|had|did|made|tried)|last (?:year|semester|summer|month|week)|during (?:my|our|the)|in (?:college|school|my second year|my third year|my final year|first year)|at my internship|in the hackathon)\b/i;
const OWNERSHIP_RE =
  /\bi\s+(?:personally\s+|myself\s+|also\s+|then\s+|just\s+|actually\s+|basically\s+|mainly\s+|mostly\s+)?(?:did|made|built|designed|implemented|wrote|created|developed|led|decided|fixed|debugged|solved|optimi[sz]ed|proposed|set\s+up|setup|deployed|refactored|chose|picked|selected|handled|owned|tested|analy[sz]ed|trained|measured|profiled|migrated|organi[sz]ed|convinced|presented|added|used|worked\s+on|took|stored|configured|integrated|connected|checked|found|learned|learnt|tried|split|kept|removed|changed|moved|converted|replaced|installed|automated|managed|ran|coded|structured|planned|reviewed|explained|shipped|delivered|was\s+responsible\s+for|was\s+the\s+one|was\s+in\s+charge)\b|\bmy\s+(?:part|job|role|responsibility|task)\s+(?:was|is)\b|\bi\s+was\s+(?:doing|handling|building|writing|working\s+on)\b/i;
const NUMBER_RE =
  /\b\d+(?:\.\d+)?\s*(?:%|percent|ms\b|seconds?|x\b|times|users?|requests?|k\b|lakh|crore|million|hours?|days?|weeks?|months?|years?|rows?|records?|mb\b|gb\b|people|members?|students?)?|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|fifty|hundred|thousand|million|lakh|crore|half|double|twice|dozens?|couple)\b\s+(?:of\s+)?(?:\w+)/i;
/** Claims that overreach: expertise or totality asserted rather than shown. */
const ABSOLUTE_RE = /\b(expert|perfectly|never fails|never failed|always works|100 ?%|single-?handedly|all by myself|everything (?:myself|alone|on my own)|the (?:entire|whole) (?:project|system|app|application|thing) (?:myself|alone|on my own)|i know (?:everything|all) about)\b/i;
const COMPLEXITY_RE = /\bo\s*\(\s*(?:1|n|log\s*n|n\s*log\s*n|n\s*\^?\s*2|n2|k|m\s*\+\s*n|n\s*log\s*k)\s*\)|\b(?:constant|linear|logarithmic|quadratic|n log n|n log k|log n) (?:time|space)\b/i;

/** Named technologies, structures and concepts — what makes an answer specific.
 * Includes the plain words spoken answers actually use ("the backend", "a
 * bucket", "the login page"), not only brand names. */
const TECH_TERMS = [
  "react", "angular", "vue", "next.js", "node.js", "node", "express", "spring boot", "spring", "django", "flask", "fastapi",
  "java", "python", "javascript", "typescript", "c++", "sql", "mysql", "postgresql", "postgres", "mongodb", "mongo", "redis", "kafka",
  "docker", "kubernetes", "aws", "azure", "gcp", "jenkins", "terraform", "git", "github", "linux", "rest", "graphql", "jwt", "oauth",
  "hashmap", "hash map", "hash table", "binary search", "linked list", "heap", "graph", "dynamic programming", "recursion", "big o",
  "tensorflow", "pytorch", "pandas", "numpy", "scikit-learn", "tableau", "power bi", "excel", "selenium", "cypress",
  "playwright", "junit", "pytest", "postman", "ci/cd", "microservice", "websocket", "redux", "tailwind", "html", "css",
  "jvm", "garbage collection", "garbage collector", "thread", "mutex", "index", "transaction", "normalization", "cache", "load balancer",
  "api", "stack", "queue", "tree", "array", "hash", "bfs", "dfs", "sliding window", "two pointer", "slow and fast pointer", "regression",
  "classification", "precision", "recall", "a/b test", "p-value", "dashboard", "pipeline", "container", "deadlock",
  "backend", "back end", "frontend", "front end", "database", "server", "endpoint", "login", "authentication", "auth", "token", "session",
  "schema", "table", "query", "join", "primary key", "foreign key", "unique constraint", "unique check", "bucket", "collision", "pointer",
  "interface", "abstract class", "class", "object", "method", "inheritance", "polymorphism", "encapsulation", "singleton", "factory",
  "immutable", "string pool", "hash code", "constant time", "linear time", "log n", "n log n", "n log k", "complexity",
  "model", "dataset", "training", "feature", "accuracy", "overfitting", "component", "state", "props", "hook", "route", "controller",
  "service", "repository", "function", "loop", "variable", "exception", "null", "listing", "checkout", "payment", "order", "cart",
  "deployment", "deploy", "monitoring", "alert", "test case", "unit test", "integration test", "regression test", "bug", "race condition",
  "concurrency", "lock", "auto configuration", "dependency injection", "bean", "annotation", "sql injection", "cors", "http", "https", "dns",
  "tcp", "udp", "process", "memory", "heap memory", "stack memory", "virtual memory", "scheduler",
];

const LABEL_CASE: Record<string, string> = {
  "next.js": "Next.js", "node.js": "Node.js", "spring boot": "Spring Boot", "c++": "C++", sql: "SQL", mysql: "MySQL",
  postgresql: "PostgreSQL", mongodb: "MongoDB", aws: "AWS", gcp: "GCP", jwt: "JWT", "ci/cd": "CI/CD", html: "HTML",
  css: "CSS", jvm: "JVM", api: "API", bfs: "BFS", dfs: "DFS", graphql: "GraphQL", typescript: "TypeScript",
  javascript: "JavaScript", "power bi": "Power BI", "a/b test": "A/B test", "scikit-learn": "scikit-learn", hashmap: "HashMap",
};

/** Plain words that are only "specific" when they come with something else. */
const GENERIC_TECH = new Set(["class", "object", "method", "function", "loop", "variable", "state", "model", "feature", "service", "process", "memory", "table", "order", "cart", "bug", "server", "token", "session", "route", "component", "index", "join", "queue", "stack", "tree", "graph", "hash", "array", "string pool"]);

const patternCache = new Map<string, RegExp>();

function termPattern(term: string): RegExp {
  let re = patternCache.get(term);
  if (!re) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Plain words match on word boundaries with an optional plural ("java"
    // never fires on "javascript", "api" does fire on "APIs"); anything with
    // symbols matches as a substring ("o(n)", "ci/cd").
    re = /^[a-z][a-z' -]*[a-z]$/.test(term) ? new RegExp(`(?<![a-z])${escaped}(?:s|es)?(?![a-z])`, "i") : new RegExp(escaped, "i");
    patternCache.set(term, re);
  }
  return re;
}

export function countKeywordHits(text: string, keywords: readonly string[]): number {
  let hits = 0;
  for (const k of keywords) if (termPattern(k).test(text)) hits++;
  return hits;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function isCode(text: string): boolean {
  return text.trim().startsWith("```");
}

export function readSignals(text: string, projectNames: readonly string[] = []): AnswerSignals {
  const words = wordCount(text);
  const techTerms = TECH_TERMS.filter((t) => termPattern(t).test(text));
  const lower = text.toLowerCase();
  const namesProject = projectNames.some((p) => p && lower.includes(p.toLowerCase()));
  return {
    words,
    numbers: NUMBER_RE.test(text),
    techTerms: [...new Set(techTerms)].slice(0, 10),
    ownership: OWNERSHIP_RE.test(text),
    causal: CAUSAL_RE.test(text),
    example: EXAMPLE_RE.test(text) || namesProject,
    hedges: (text.match(HEDGE_RE) ?? []).length,
    absolute: ABSOLUTE_RE.test(text),
    code: isCode(text),
    question: looksLikeCandidateQuestion(text),
  };
}

/** How much verifiable substance the answer carries: named things, numbers,
 * ownership, reasons, examples. Generic words ("class", "function") count
 * half; brand and structure names count full. */
export function specificityOf(s: AnswerSignals): number {
  const specific = s.techTerms.filter((t) => !GENERIC_TECH.has(t)).length;
  const generic = s.techTerms.length - specific;
  const named = Math.min(2.5, specific + generic * 0.5);
  return Math.round((named + (s.numbers ? 1 : 0) + (s.ownership ? 1 : 0) + (s.causal ? 1 : 0) + (s.example ? 1 : 0) - (s.hedges >= 2 ? 1 : 0)) * 2) / 2;
}

export function qualityOf(text: string, s: AnswerSignals): AnswerQuality {
  if (isNoAnswer(text) || s.words === 0) return "silent";
  if (s.code) {
    const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("```")).length;
    if (lines < 4) return "vague";
    return COMPLEXITY_RE.test(text) && lines >= 6 ? "strong" : "adequate";
  }
  const spec = specificityOf(s);
  if (TAP_OUT_RE.test(text) && s.words < 35 && spec < 2) return "tap-out";
  if ((s.words >= 30 && spec >= 4) || (s.words >= 20 && spec >= 5)) return "strong";
  if ((s.words >= 18 && spec >= 2) || (s.words >= 30 && spec >= 1) || s.words >= 55) return "adequate";
  return "vague";
}

export interface AnalysisContext {
  index: number;
  /** The interviewer line this answer responds to. */
  question: string | null;
  /** The competency the current thread is assessing. */
  threadCompetency: string | null;
  plan: InterviewPlan;
}

function defaultCompetency(plan: InterviewPlan): string | null {
  const ids = plan.competencies.map((c) => c.id);
  if (plan.roundType === "technical" && ids.includes("projects")) return "projects";
  if (ids.includes("communication")) return "communication";
  return ids[0] ?? null;
}

export function analyzeAnswer(text: string, ctx: AnalysisContext): AnswerAnalysis {
  const signals = readSignals(text, ctx.plan.resume?.projects ?? []);
  const quality = qualityOf(text, signals);
  const flags: AnswerFlag[] = [];
  if (signals.code) flags.push("code");
  if (signals.hedges >= 2) flags.push("hedged");
  if (signals.question && signals.words < 30 && quality !== "strong" && quality !== "adequate") flags.push("asked-question");
  const specificity = specificityOf(signals);
  // An overclaim is a sweeping claim with nothing behind it — never a plain
  // "I did the whole backend part" that names what the backend was.
  if (signals.absolute && quality !== "silent" && quality !== "tap-out" && specificity <= 1.5 && !signals.code) flags.push("overclaim");

  const credits: { id: string; weight: number }[] = [];
  const primary = ctx.threadCompetency && ctx.plan.competencies.some((c) => c.id === ctx.threadCompetency) ? ctx.threadCompetency : defaultCompetency(ctx.plan);
  if (quality !== "silent" && !flags.includes("asked-question")) {
    if (primary) credits.push({ id: primary, weight: 1 });
    for (const comp of ctx.plan.competencies) {
      if (comp.id === primary) continue;
      const def = COMPETENCIES[comp.id];
      if (!def) continue;
      const hits = countKeywordHits(text, def.keywords);
      if (hits >= 2) credits.push({ id: comp.id, weight: 0.5 });
      else if (hits === 1 && (quality === "strong" || quality === "adequate")) credits.push({ id: comp.id, weight: 0.25 });
    }
    // In a behavioural round, every answer is also evidence of how they talk.
    if (ctx.plan.roundType === "hr" && primary !== "communication" && quality !== "tap-out" && ctx.plan.competencies.some((c) => c.id === "communication")) {
      const existing = credits.find((c) => c.id === "communication");
      if (existing) existing.weight = Math.max(existing.weight, 0.35);
      else credits.push({ id: "communication", weight: 0.35 });
    }
    if (primary && ctx.plan.roundType === "technical" && quality !== "tap-out" && signals.words >= 25) {
      const primaryDef = COMPETENCIES[primary];
      const primaryHits = primaryDef ? countKeywordHits(text, primaryDef.keywords) : 1;
      const elsewhere = credits.some((c) => c.id !== primary && c.weight >= 0.5);
      if (primaryHits === 0 && elsewhere) flags.push("off-topic");
    }
  }

  let salient: string | null = null;
  const lower = text.toLowerCase();
  const project = (ctx.plan.resume?.projects ?? []).find((p) => p && lower.includes(p.toLowerCase()));
  if (project) salient = project;
  else {
    const specific = signals.techTerms.find((t) => !GENERIC_TECH.has(t));
    if (specific) salient = LABEL_CASE[specific] ?? specific.charAt(0).toUpperCase() + specific.slice(1);
  }

  return { index: ctx.index, text, quality, signals, specificity, credits, flags, salient };
}
