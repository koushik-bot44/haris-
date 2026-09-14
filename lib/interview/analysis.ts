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

const HEDGE_RE = /\b(i think|i guess|maybe|probably|kind of|sort of|not sure|i believe|perhaps|i suppose|something like|more or less)\b/gi;
const TAP_OUT_RE =
  /\b(i\s+(?:really\s+|honestly\s+)?don'?t\s+know|i\s+do\s+not\s+know|no\s+idea|no\s+clue|not\s+sure\s+(?:about\s+)?(?:that|this|how|what|why)|i\s+(?:haven'?t|have\s+not|never)\s+(?:worked|used|done|learned|learnt|studied|come\s+across)|i\s+can'?t\s+(?:recall|remember|say)|i'?m\s+not\s+(?:familiar|aware|sure)|(?:can|could)\s+(?:we|i)\s+skip|i\s+(?:forgot|don'?t\s+remember)|i\s+(?:pass|give\s+up))\b/i;
const CAUSAL_RE = /\b(because|so that|which meant|that's why|therefore|trade-?offs?|instead of|rather than|the reason|as a result|in order to|so we|so i|which is why|that way)\b/i;
const EXAMPLE_RE =
  /\b(for example|for instance|e\.g\.|such as|one time|in my (?:project|internship|final[- ]year|previous)|when (?:i|we) (?:was|were|built|worked|had|did)|last (?:year|semester|summer|month)|during (?:my|our|the))\b/i;
const OWNERSHIP_RE =
  /\bi\s+(?:personally\s+)?(?:designed|built|implemented|wrote|created|developed|led|decided|fixed|debugged|optimi[sz]ed|proposed|set up|deployed|refactored|chose|handled|owned|tested|analy[sz]ed|trained|measured|profiled|migrated|organi[sz]ed|convinced|presented)\b/i;
const NUMBER_RE = /\b\d+(?:\.\d+)?\s*(?:%|percent|ms\b|seconds?|x\b|times|users?|requests?|k\b|lakh|crore|million|hours?|days?|weeks?|months?|years?|rows?|records?|mb\b|gb\b|people|members?|students?)?/i;
const ABSOLUTE_RE = /\b(entire|whole|everything|all by myself|single-?handedly|on my own|alone|100%|expert|perfectly|never (?:fails|failed)|always works|all of (?:it|the))\b/i;
const COMPLEXITY_RE = /\bo\s*\(\s*(?:1|n|log\s*n|n\s*log\s*n|n\s*\^?\s*2|n2|k|m\s*\+\s*n)\s*\)/i;

/** Named technologies and concepts — what makes an answer specific. */
const TECH_TERMS = [
  "react", "angular", "vue", "next.js", "node.js", "node", "express", "spring boot", "spring", "django", "flask", "fastapi",
  "java", "python", "javascript", "typescript", "c++", "sql", "mysql", "postgresql", "postgres", "mongodb", "redis", "kafka",
  "docker", "kubernetes", "aws", "azure", "gcp", "jenkins", "terraform", "git", "linux", "rest", "graphql", "jwt", "oauth",
  "hashmap", "hash map", "binary search", "linked list", "heap", "graph", "dynamic programming", "recursion", "big o",
  "tensorflow", "pytorch", "pandas", "numpy", "scikit-learn", "tableau", "power bi", "excel", "selenium", "cypress",
  "playwright", "junit", "pytest", "postman", "ci/cd", "microservices", "websocket", "redux", "tailwind", "html", "css",
  "jvm", "garbage collection", "thread", "mutex", "index", "transaction", "normalization", "cache", "load balancer",
  "api", "stack", "queue", "tree", "array", "hash", "bfs", "dfs", "sliding window", "two pointer", "regression",
  "classification", "precision", "recall", "a/b test", "p-value", "dashboard", "pipeline", "container", "deadlock",
];

const LABEL_CASE: Record<string, string> = {
  "next.js": "Next.js", "node.js": "Node.js", "spring boot": "Spring Boot", "c++": "C++", sql: "SQL", mysql: "MySQL",
  postgresql: "PostgreSQL", mongodb: "MongoDB", aws: "AWS", gcp: "GCP", jwt: "JWT", "ci/cd": "CI/CD", html: "HTML",
  css: "CSS", jvm: "JVM", api: "API", bfs: "BFS", dfs: "DFS", graphql: "GraphQL", typescript: "TypeScript",
  javascript: "JavaScript", "power bi": "Power BI", "a/b test": "A/B test", "scikit-learn": "scikit-learn",
};

const patternCache = new Map<string, RegExp>();

function termPattern(term: string): RegExp {
  let re = patternCache.get(term);
  if (!re) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Plain words match on word boundaries ("java" never fires on "javascript");
    // anything with symbols matches as a substring ("o(n)", "ci/cd").
    re = /^[a-z][a-z' -]*[a-z]$/.test(term) ? new RegExp(`(?<![a-z])${escaped}(?![a-z])`, "i") : new RegExp(escaped, "i");
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

export function readSignals(text: string): AnswerSignals {
  const words = wordCount(text);
  const techTerms = TECH_TERMS.filter((t) => termPattern(t).test(text));
  return {
    words,
    numbers: NUMBER_RE.test(text) && /\d/.test(text),
    techTerms: [...new Set(techTerms)].slice(0, 8),
    ownership: OWNERSHIP_RE.test(text),
    causal: CAUSAL_RE.test(text),
    example: EXAMPLE_RE.test(text),
    hedges: (text.match(HEDGE_RE) ?? []).length,
    absolute: ABSOLUTE_RE.test(text),
    code: isCode(text),
    question: looksLikeCandidateQuestion(text),
  };
}

export function specificityOf(s: AnswerSignals): number {
  return (s.numbers ? 1 : 0) + Math.min(2, s.techTerms.length) + (s.ownership ? 1 : 0) + (s.causal ? 1 : 0) + (s.example ? 1 : 0) - (s.hedges >= 2 ? 1 : 0);
}

export function qualityOf(text: string, s: AnswerSignals): AnswerQuality {
  if (isNoAnswer(text) || s.words === 0) return "silent";
  if (s.code) {
    const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("```")).length;
    if (lines < 4) return "vague";
    return COMPLEXITY_RE.test(text) && lines >= 6 ? "strong" : "adequate";
  }
  if (TAP_OUT_RE.test(text) && s.words < 30) return "tap-out";
  const spec = specificityOf(s);
  if ((s.words >= 40 && spec >= 4) || (s.words >= 25 && spec >= 5)) return "strong";
  if (s.words >= 20 && spec >= 2) return "adequate";
  if (s.words >= 60 && spec >= 1) return "adequate";
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
  const signals = readSignals(text);
  const quality = qualityOf(text, signals);
  const flags: AnswerFlag[] = [];
  if (signals.code) flags.push("code");
  if (signals.hedges >= 2) flags.push("hedged");
  if (signals.question && signals.words < 30 && quality !== "strong" && quality !== "adequate") flags.push("asked-question");
  const specificity = specificityOf(signals);
  if (signals.absolute && quality !== "silent" && quality !== "tap-out" && specificity <= 2 && !signals.code) flags.push("overclaim");

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
  if (signals.techTerms.length) {
    const t = signals.techTerms[0];
    salient = LABEL_CASE[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
  } else if (ctx.plan.resume) {
    const lower = text.toLowerCase();
    salient = ctx.plan.resume.projects.find((p) => p && lower.includes(p.toLowerCase())) ?? null;
  }

  return { index: ctx.index, text, quality, signals, specificity, credits, flags, salient };
}
