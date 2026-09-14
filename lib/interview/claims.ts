import type { Claim, Contradiction, ContradictionKind } from "@/lib/interview/types";
import type { ResumeProfile } from "@/lib/types";

// Claims and contradictions, deterministically.
//
// A claim is something the candidate says about THEMSELVES that an interviewer
// would want to verify: what they owned, how long they have used something,
// what they did not touch. Contradictions are pairs of claims that cannot both
// be true — and every one of them is anchored to two verbatim quotes, so the
// interviewer can say "earlier you said X" only when X is literally what was
// said. That is the difference between an evidence-based follow-up and a random
// confrontation.
//
// The background model can add claims regex cannot see (lib/llm/analyze.ts);
// those go through the same quote verification before they count.

const NORMALIZE_APOSTROPHES = /[’‘`]/g;

/** Specific tools, each mapped to the area it belongs to. Longest first so
 * "spring boot" wins over "spring". */
const TECH: { term: string; re: RegExp; parent: string | null }[] = [
  ["spring boot", /\bspring\s?boot\b/, "backend"],
  ["react native", /\breact native\b/, "mobile"],
  ["next.js", /\bnext\.?js\b/, "frontend"],
  ["node.js", /\bnode(?:\.?js)?\b/, "backend"],
  ["power bi", /\bpower\s?bi\b/, "data"],
  ["scikit-learn", /\bscikit[-\s]?learn\b|\bsklearn\b/, "ml"],
  ["ci/cd", /\bci\s?\/\s?cd\b/, "devops"],
  ["rest api", /\brest(?:ful)?\s?apis?\b/, "backend"],
  ["postgresql", /\bpostgres(?:ql)?\b/, "database"],
  ["mongodb", /\bmongo(?:\s?db)?\b/, "database"],
  ["mysql", /\bmysql\b/, "database"],
  ["kubernetes", /\bkubernetes\b|\bk8s\b/, "devops"],
  ["tensorflow", /\btensorflow\b/, "ml"],
  ["pytorch", /\bpytorch\b/, "ml"],
  ["typescript", /\btypescript\b/, "frontend"],
  ["javascript", /\bjavascript\b/, "frontend"],
  ["graphql", /\bgraphql\b/, "backend"],
  ["django", /\bdjango\b/, "backend"],
  ["fastapi", /\bfastapi\b/, "backend"],
  ["express", /\bexpress(?:\.?js)?\b/, "backend"],
  ["flask", /\bflask\b/, "backend"],
  ["angular", /\bangular\b/, "frontend"],
  ["react", /\breact(?:\.?js)?\b/, "frontend"],
  ["vue", /\bvue(?:\.?js)?\b/, "frontend"],
  ["tailwind", /\btailwind\b/, "frontend"],
  ["redis", /\bredis\b/, "database"],
  ["kafka", /\bkafka\b/, "backend"],
  ["docker", /\bdocker\b/, "devops"],
  ["jenkins", /\bjenkins\b/, "devops"],
  ["terraform", /\bterraform\b/, "devops"],
  ["aws", /\baws\b/, "devops"],
  ["azure", /\bazure\b/, "devops"],
  ["gcp", /\bgcp\b|\bgoogle cloud\b/, "devops"],
  ["selenium", /\bselenium\b/, "testing"],
  ["cypress", /\bcypress\b/, "testing"],
  ["playwright", /\bplaywright\b/, "testing"],
  ["junit", /\bjunit\b/, "testing"],
  ["pytest", /\bpytest\b/, "testing"],
  ["pandas", /\bpandas\b/, "data"],
  ["numpy", /\bnumpy\b/, "data"],
  ["tableau", /\btableau\b/, "data"],
  ["excel", /\bexcel\b/, "data"],
  ["flutter", /\bflutter\b/, "mobile"],
  ["html", /\bhtml5?\b/, "frontend"],
  ["css", /\bcss3?\b/, "frontend"],
  ["sql", /\bsql\b/, "database"],
  ["java", /\bjava\b(?!\s?script)/, null],
  ["python", /\bpython\b/, null],
  ["c++", /c\+\+/, null],
  ["git", /\bgit\b/, null],
  ["linux", /\blinux\b/, "devops"],
].map(([term, re, parent]) => ({ term: term as string, re: re as RegExp, parent: parent as string | null }));

/** Areas a person can plausibly own on their own. Order matters: specific
 * areas first, so "the backend architecture" reads as backend. */
const AREAS: { area: string; re: RegExp }[] = [
  { area: "backend", re: /\b(back[\s-]?end|server[\s-]?side|server|apis?|business logic|endpoints?|microservices?)\b/ },
  { area: "frontend", re: /\b(front[\s-]?end|ui|user interface|client[\s-]?side|pages?|screens?|layouts?|styling|components?)\b/ },
  { area: "database", re: /\b(database|databases|db|schema|queries|data model|tables)\b/ },
  { area: "devops", re: /\b(deployment|deployments|deploying|infrastructure|infra|pipelines?|hosting|cloud setup)\b/ },
  { area: "ml", re: /\b(models?|machine learning|training pipeline|neural networks?)\b/ },
  { area: "testing", re: /\b(tests?|testing|test cases?|qa)\b/ },
  { area: "mobile", re: /\b(android|ios|mobile app)\b/ },
  { area: "design", re: /\b(ux|wireframes?|figma|mockups?)\b/ },
  { area: "data", re: /\b(dashboards?|reports?|data analysis|analytics)\b/ },
  { area: "team", re: /\b(team|group|squad)\b/ },
  { area: "fullstack", re: /\b(full[\s-]?stack|end[\s-]to[\s-]end|entire (?:project|app|application|system|thing)|whole (?:project|app|application|system|thing)|everything)\b/ },
  { area: "architecture", re: /\b(architecture|system design|overall design|the system)\b/ },
];

/** Areas a single person can be said to have worked on "only". */
const SCOPE_AREAS = new Set(["backend", "frontend", "database", "devops", "ml", "testing", "mobile", "design", "data"]);
const KNOWN_AREAS = new Set([...SCOPE_AREAS, "team", "fullstack", "architecture"]);

export function canonicalArea(phrase: string): { area: string | null; tech?: string } {
  const p = ` ${phrase.toLowerCase().replace(NORMALIZE_APOSTROPHES, "'")} `;
  for (const t of TECH) {
    if (t.re.test(p)) return { area: t.parent, tech: t.term };
  }
  for (const a of AREAS) {
    if (a.re.test(p)) return { area: a.area };
  }
  return { area: null };
}

const SUBJECT = String.raw`\bi(?:'ve|'d|\s+have|\s+had)?\s+`;
const STOP = String.raw`(?=[.;!?]|,\s|\s+(?:and|but|using|with|for|because|so|which|where|while|then|though|although|at|in\s+(?:my|our|the)\s+(?:internship|company|college|project))\b|$)`;

const OWNERSHIP_RE = new RegExp(
  `${SUBJECT}(?:personally\\s+|single-?handedly\\s+|mainly\\s+|mostly\\s+|also\\s+|actually\\s+|basically\\s+|completely\\s+)?` +
    `(designed|architected|built|implemented|developed|created|wrote|coded|led|owned|managed|deployed|optimi[sz]ed|set\\s+up|configured|migrated|refactored|automated|handled|ran)\\s+` +
    `(.{3,80}?)${STOP}`,
  "gi",
);

const EXCLUSIVE_RE = new RegExp(
  `(?:${SUBJECT}(?:was\\s+|were\\s+)?|\\bmy\\s+(?:part|role|work)\\s+was\\s+)(only|just|mostly|mainly|primarily|purely|solely)\\s+` +
    `(?:(?:worked|work|working)\\s+on\\s+|did\\s+|doing\\s+|handled\\s+|focused\\s+on\\s+|responsible\\s+for\\s+|contributed\\s+to\\s+|on\\s+)?` +
    `(.{2,60}?)${STOP.replace("(?:and|but", "(?:and|but|part|side|stuff|things|bits")}`,
  "gi",
);

const NEGATION_RE = new RegExp(
  `${SUBJECT}(?:never|not|haven't|hadn't|didn't|did\\s+not|don't|do\\s+not|have\\s+not)\\s+(?:really\\s+|actually\\s+|ever\\s+|even\\s+)?` +
    `(?:used|use|worked\\s+(?:with|on|in)|work\\s+(?:with|on)|touched|touch|written|write|built|build|done|know|learned|learnt|studied|tried)\\s+` +
    `(?:any\\s+|the\\s+|much\\s+|with\\s+)?(.{2,40}?)${STOP}`,
  "gi",
);

const EXPERIENCE_RE = new RegExp(
  `${SUBJECT}(?:about\\s+|around\\s+|nearly\\s+|over\\s+|almost\\s+|more\\s+than\\s+)?(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|a\\s+couple\\s+of|a\\s+few)\\s+(years?|months?)\\s+` +
    `(?:of\\s+)?(?:experience\\s+|exp\\s+|hands-on\\s+experience\\s+)?(?:with|in|on|using|of)\\s+(.{2,40}?)${STOP}`,
  "gi",
);

const EXPERIENCE_FOR_RE = new RegExp(
  `${SUBJECT}been\\s+(?:using|working\\s+(?:with|on)|coding\\s+in)\\s+(.{2,30}?)\\s+for\\s+(?:about\\s+|around\\s+|over\\s+)?(\\d+(?:\\.\\d+)?|one|two|three|four|five|a\\s+couple\\s+of|a\\s+few)\\s+(years?|months?)`,
  "gi",
);

const RECENT_RE =
  /\bi(?:'ve|\s+have)?\s+(?:just|only\s+recently|recently|only\s+just)\s+(?:started|begun|began)\s+(?:learning|using|with|to\s+learn|to\s+use|working\s+with)\s+(.{2,30}?)(?=[.;!?]|,\s|\s+(?:and|but|last|this|a|few)\b|$)|\bi(?:'m|\s+am)\s+(?:very\s+|pretty\s+|quite\s+|still\s+)?new\s+to\s+(.{2,30}?)(?=[.;!?]|,\s|\s+(?:and|but)\b|$)|\bi\s+(?:started|began)\s+(?:learning|using)\s+(.{2,30}?)\s+(?:last|this)\s+(?:week|month)/gi;

const LEAD_RE =
  /\bi\s+(?:was|am)\s+(?:the\s+)?(?:team\s+lead|tech\s+lead|lead\s+developer|project\s+lead|team\s+leader|leader of the team)\b|\bi\s+led\s+(?:the|our|a|my)\s+(?:team|group|squad)\b/gi;

const MEMBER_RE =
  /\bi\s+(?:wasn't|was\s+not|didn't|did\s+not)\s+(?:the\s+)?(?:lead|leader|leading|lead\s+the\s+team|in\s+charge)\b|\bi\s+was\s+(?:just|only|simply|merely)\s+(?:a|one)\s+(?:regular\s+)?(?:team\s+)?(?:member|contributor|intern|developer)\b|\b(?:someone|somebody)\s+else\s+(?:led|was\s+leading|was\s+the\s+lead)\b/gi;

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, "a couple of": 2, "a few": 3 };

function yearsFrom(n: string, unit: string): number {
  const base = WORD_NUMBERS[n.toLowerCase().replace(/\s+/g, " ")] ?? Number(n);
  if (!Number.isFinite(base)) return 0;
  return /month/i.test(unit) ? base / 12 : base;
}

/** The sentence around a match, verbatim — the claim's evidence quote. */
function sentenceAround(text: string, start: number, end: number): string {
  let s = start;
  while (s > 0 && !/[.!?\n]/.test(text[s - 1])) s--;
  let e = end;
  while (e < text.length && !/[.!?\n]/.test(text[e])) e++;
  const sentence = text.slice(s, Math.min(text.length, e + 1)).trim();
  if (sentence.length <= 180) return sentence;
  const from = Math.max(0, start - 40);
  return text.slice(from, Math.min(text.length, from + 180)).trim();
}

function stripSubject(span: string): string {
  return span
    .trim()
    .replace(/^(?:i(?:'ve|'d|\s+have|\s+had)?|my\s+(?:part|role|work))\s+/i, "")
    .replace(/[.,;!?\s]+$/, "")
    .replace(/\s+/g, " ");
}

function roleOf(verb: string): Claim["role"] {
  const v = verb.toLowerCase();
  if (v === "led" || v === "managed") return "lead";
  if (v === "designed" || v === "architected" || v === "owned") return "owner";
  return "builder";
}

export interface ExtractOptions {
  turn: number;
  nextId: () => string;
  source?: Claim["source"];
}

/** Every claim in one answer. Pure — same text, same claims (ids aside). */
export function extractClaims(rawText: string, opts: ExtractOptions): Claim[] {
  const text = rawText.replace(NORMALIZE_APOSTROPHES, "'");
  if (!text.trim() || text.trim().startsWith("```")) return [];
  const out: Claim[] = [];
  const base = (partial: Omit<Claim, "id" | "source" | "turn" | "status" | "confidence" | "evidence" | "probes">): Claim => ({
    id: opts.nextId(),
    source: opts.source ?? "answer",
    turn: opts.turn,
    status: "unverified",
    confidence: 0.5,
    evidence: [],
    probes: 0,
    ...partial,
  });
  const push = (claim: Claim) => {
    const dup = out.find(
      (c) => c.kind === claim.kind && c.area === claim.area && c.tech === claim.tech && c.polarity === claim.polarity && Boolean(c.exclusive) === Boolean(claim.exclusive),
    );
    if (!dup) out.push(claim);
  };

  for (const m of text.matchAll(LEAD_RE)) {
    push(base({ text: stripSubject(m[0]), area: "team", kind: "role", polarity: 1, role: "lead", quote: sentenceAround(text, m.index!, m.index! + m[0].length) }));
  }
  for (const m of text.matchAll(MEMBER_RE)) {
    push(base({ text: stripSubject(m[0]), area: "team", kind: "role", polarity: -1, role: "member", quote: sentenceAround(text, m.index!, m.index! + m[0].length) }));
  }
  for (const m of text.matchAll(OWNERSHIP_RE)) {
    const verb = m[1];
    const object = m[2];
    // The tool often follows the object: "built the service using Docker".
    const own = canonicalArea(object);
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 48).split(/[.;!?]/)[0];
    const tail = /^\s+(?:using|with|in|on|through|via)\s+/i.test(after) ? canonicalArea(after) : { area: null as string | null, tech: undefined };
    const tech = own.tech ?? tail.tech;
    const area = own.area ?? tail.area;
    if (!area && !tech) continue;
    // "I led the team" is a role claim, already captured above.
    if (area === "team") continue;
    push(
      base({
        text: stripSubject(m[0]),
        area: area ?? tech!,
        ...(tech ? { tech } : {}),
        kind: "ownership",
        polarity: 1,
        role: roleOf(verb),
        quote: sentenceAround(text, m.index!, m.index! + m[0].length),
      }),
    );
  }
  for (const m of text.matchAll(EXCLUSIVE_RE)) {
    const { area, tech } = canonicalArea(m[2]);
    const scopeArea = area ?? null;
    if (!scopeArea || !SCOPE_AREAS.has(scopeArea)) continue;
    push(
      base({
        text: stripSubject(m[0]),
        area: scopeArea,
        ...(tech ? { tech } : {}),
        kind: "scope",
        polarity: 1,
        exclusive: true,
        quote: sentenceAround(text, m.index!, m.index! + m[0].length),
      }),
    );
  }
  for (const m of text.matchAll(NEGATION_RE)) {
    const { area, tech } = canonicalArea(m[1]);
    if (!tech && !(area && SCOPE_AREAS.has(area))) continue;
    push(
      base({
        text: stripSubject(m[0]),
        area: area ?? tech!,
        ...(tech ? { tech } : {}),
        kind: "negation",
        polarity: -1,
        quote: sentenceAround(text, m.index!, m.index! + m[0].length),
      }),
    );
  }
  for (const m of text.matchAll(EXPERIENCE_RE)) {
    const { area, tech } = canonicalArea(m[3]);
    if (!tech) continue;
    push(
      base({
        text: stripSubject(m[0]),
        area: area ?? tech,
        tech,
        kind: "experience",
        polarity: 1,
        years: yearsFrom(m[1], m[2]),
        quote: sentenceAround(text, m.index!, m.index! + m[0].length),
      }),
    );
  }
  for (const m of text.matchAll(EXPERIENCE_FOR_RE)) {
    const { area, tech } = canonicalArea(m[1]);
    if (!tech) continue;
    push(
      base({
        text: stripSubject(m[0]),
        area: area ?? tech,
        tech,
        kind: "experience",
        polarity: 1,
        years: yearsFrom(m[2], m[3]),
        quote: sentenceAround(text, m.index!, m.index! + m[0].length),
      }),
    );
  }
  for (const m of text.matchAll(RECENT_RE)) {
    const subject = m[1] ?? m[2] ?? m[3] ?? "";
    const { area, tech } = canonicalArea(subject);
    if (!tech) continue;
    push(
      base({
        text: stripSubject(m[0]),
        area: area ?? tech,
        tech,
        kind: "timeline",
        polarity: 1,
        recent: true,
        quote: sentenceAround(text, m.index!, m.index! + m[0].length),
      }),
    );
  }
  return out;
}

/** Claims the resume makes — what the interview sets out to verify. */
export function resumeClaims(profile: ResumeProfile, nextId: () => string): Claim[] {
  const out: Claim[] = [];
  for (const skill of profile.skills.slice(0, 10)) {
    const { area, tech } = canonicalArea(skill);
    out.push({
      id: nextId(),
      text: `lists ${skill} on the resume`,
      area: area ?? (tech ?? skill.toLowerCase()),
      ...(tech ? { tech } : {}),
      kind: "skill",
      polarity: 1,
      source: "resume",
      turn: -1,
      quote: skill,
      status: "unverified",
      confidence: 0.5,
      evidence: [],
      probes: 0,
    });
  }
  for (const project of profile.projects.slice(0, 3)) {
    const { area, tech } = canonicalArea(`${project.name} ${project.summary}`);
    out.push({
      id: nextId(),
      text: `built ${project.name}`,
      area: `project:${project.name.toLowerCase()}`,
      ...(tech ? { tech } : {}),
      kind: "ownership",
      polarity: 1,
      role: "builder",
      source: "resume",
      turn: -1,
      quote: project.name,
      status: "unverified",
      confidence: 0.5,
      evidence: [],
      probes: 0,
      competency: "projects",
    });
    void area;
  }
  return out;
}

/** Why two claims cannot both hold — or null when they can. */
export function conflictBetween(a: Claim, b: Claim): ContradictionKind | null {
  if (a.turn === b.turn && a.source !== "resume" && b.source !== "resume") return null; // a self-qualification inside one answer
  const resumeInvolved = a.source === "resume" || b.source === "resume";

  // Same subject, opposite polarity: "built the API in Spring Boot" vs "never used Spring Boot".
  const sameTech = Boolean(a.tech && b.tech && a.tech === b.tech);
  const sameArea = !a.tech && !b.tech && a.area === b.area && KNOWN_AREAS.has(a.area);
  if ((sameTech || sameArea) && a.polarity !== b.polarity && a.kind !== "role" && b.kind !== "role") {
    return resumeInvolved ? "resume" : "polarity";
  }

  // Role: "I led the team" vs "I was just a team member".
  if (a.kind === "role" && b.kind === "role" && a.polarity !== b.polarity) return "role";

  // Scope: owning one area vs "I only worked on" a different one.
  const excl = a.exclusive ? a : b.exclusive ? b : null;
  const other = excl === a ? b : a;
  if (excl && other !== excl && !other.exclusive && other.polarity === 1 && (other.kind === "ownership" || other.kind === "experience") && other.source !== "resume") {
    if (other.area === "fullstack" || other.area === "architecture") return "scope";
    if (SCOPE_AREAS.has(other.area) && other.area !== excl.area) return "scope";
  }

  // Timeline: "three years of React" vs "I just started learning React".
  if (sameTech) {
    const long = (c: Claim) => (c.years ?? 0) >= 1;
    if ((long(a) && b.recent) || (long(b) && a.recent)) return "timeline";
  }
  return null;
}

const EXPLAIN: Record<ContradictionKind, string> = {
  scope: "claimed ownership of one area but later said their work was limited to a different one",
  polarity: "said they used something and later said they had not",
  role: "described leading and later described being a regular member",
  timeline: "described long experience with something they later said they had only just started",
  resume: "the resume lists something the candidate later said they had not used",
};

/** Contradictions a batch of new claims opens against everything already known. */
export function detectContradictions(
  fresh: Claim[],
  known: Claim[],
  existing: Contradiction[],
  nextId: () => string,
): Contradiction[] {
  const out: Contradiction[] = [];
  const seen = new Set(existing.map((x) => [x.a, x.b].sort().join("|")));
  for (const b of fresh) {
    for (const a of known) {
      if (a.id === b.id) continue;
      const kind = conflictBetween(a, b);
      if (!kind) continue;
      const key = [a.id, b.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const [earlier, later] = a.turn <= b.turn ? [a, b] : [b, a];
      out.push({
        id: nextId(),
        kind,
        a: earlier.id,
        b: later.id,
        textA: earlier.text,
        textB: later.text,
        quoteA: earlier.quote,
        quoteB: later.quote,
        turnA: earlier.turn,
        turnB: later.turn,
        status: "open",
        explanation: EXPLAIN[kind],
        source: "heuristic",
      });
    }
  }
  return out;
}

/** First-person claim text → something the interviewer can say back. */
export function secondPerson(text: string): string {
  return text
    .replace(/\bI'm\b/g, "you're")
    .replace(/\bI am\b/gi, "you are")
    .replace(/\bI was\b/gi, "you were")
    .replace(/^was\b/i, "were")
    .replace(/^am\b/i, "are")
    .replace(/\bmy\b/gi, "your")
    .replace(/\bmyself\b/gi, "yourself")
    .replace(/\bme\b/gi, "you")
    .replace(/\bI\b/g, "you");
}
