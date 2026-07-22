import type { ResumeProfile } from "@/lib/types";

// Deterministic resume → ResumeProfile extraction. PURE on purpose: regex and
// heuristics only — no LLM, no fetch, no wall clock — so the setup page can run
// it on every keystroke and the interviewer knows the candidate before the
// first word is spoken. Same input, same profile, always.
//
// Experience rule (load-bearing — flips HR to the why-change/package track):
// experienced=true only when a NON-intern role title appears outside education
// context, OR non-intern work year-ranges sum to ≥ 1 year. Intern-only history
// stays experienced=false — the "fresher with internship" track, by design.

type Section = "none" | "experience" | "projects" | "education" | "skills" | "other";

// "present"/"current" endpoints resolve against the max year in the document
// (not the wall clock) so the function stays pure and replays byte-identical.
const RANGE_RE = /\b((?:19|20)\d{2})\s*(?:[-–—]|to)\s*((?:19|20)\d{2}|present|current|now|date|today)\b/gi;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;

const TITLE_RE = /\b(engineer(ing)?|developer|sde|swe|programmer|consultant|analyst|architect|tech lead|team lead|manager|devops|administrator|scientist|intern(ship)?s?|trainee)\b/i;
const INTERN_RE = /\bintern(ship)?s?\b/i;
// Objective/summary phrasing that mentions a title without holding it.
const ASPIRATION_RE = /\b(aspiring|seeking|looking for|passionate|objective|fresher|to become)\b/i;
const EDU_RE = /\b(b\.?tech|b\.e\.?|m\.?tech|m\.e\.?|b\.?sc|m\.?sc|bca|mca|mba|ph\.?d|bachelor|master|diploma|university|college|institute|school|cgpa|gpa|matriculation|secondary|degree)\b/i;
const DEGREE_RE = /\b(b\.?tech|b\.e\.?|m\.?tech|m\.e\.?|b\.?sc|m\.?sc|bca|mca|mba|ph\.?d|bachelor(?:'s)?|master(?:'s)?)\b/i;
const BULLET_RE = /^\s*(?:[-•*·◦▪‣→]|\d+[.)])\s*/;

// Curated ~40-term dictionary, in interview-priority order (cap 10 keeps the
// front). Word-boundary patterns so "java" never fires on "javascript".
const SKILL_DICT: { label: string; re: RegExp }[] = [
  { label: "DSA", re: /\bdsa\b/i },
  { label: "Data Structures", re: /\bdata structures?\b/i },
  { label: "Algorithms", re: /\balgorithms?\b/i },
  { label: "Java", re: /\bjava\b/i },
  { label: "Python", re: /\bpython\b/i },
  { label: "C++", re: /c\+\+/i },
  // Standalone C: delimiter-bounded so "C.S.E" and "C++" never count.
  { label: "C", re: /(?:^|[\s,(/])C(?:[\s,)/]|$)/m },
  { label: "JavaScript", re: /\bjavascript\b/i },
  { label: "TypeScript", re: /\btypescript\b/i },
  { label: "Full Stack", re: /\bfull[\s-]?stack\b/i },
  { label: "React", re: /\breact(\.?js)?\b/i },
  { label: "Next.js", re: /\bnext\.?js\b/i },
  { label: "Node.js", re: /\bnode(\.?js)?\b/i },
  { label: "Express", re: /\bexpress(\.?js)?\b/i },
  { label: "Angular", re: /\bangular\b/i },
  { label: "Vue", re: /\bvue(\.?js)?\b/i },
  { label: "HTML", re: /\bhtml5?\b/i },
  { label: "CSS", re: /\bcss3?\b/i },
  { label: "Tailwind", re: /\btailwind(css)?\b/i },
  { label: "SQL", re: /\bsql\b/i },
  { label: "MySQL", re: /\bmysql\b/i },
  { label: "PostgreSQL", re: /\bpostgres(ql)?\b/i },
  { label: "MongoDB", re: /\bmongo\s?db\b/i },
  { label: "Redis", re: /\bredis\b/i },
  { label: "REST APIs", re: /\brest(ful)?[\s-]?api/i },
  { label: "GraphQL", re: /\bgraphql\b/i },
  { label: "System Design", re: /\bsystem design\b/i },
  { label: "AWS", re: /\baws\b|\bamazon web services\b/i },
  { label: "Azure", re: /\bazure\b/i },
  { label: "GCP", re: /\bgcp\b|\bgoogle cloud\b/i },
  { label: "Docker", re: /\bdocker\b/i },
  { label: "Kubernetes", re: /\bkubernetes\b|\bk8s\b/i },
  { label: "CI/CD", re: /\bci\/cd\b|\bcicd\b/i },
  { label: "Machine Learning", re: /\bmachine learning\b|\bml\b/i },
  { label: "Deep Learning", re: /\bdeep learning\b|\bneural network/i },
  { label: "TensorFlow", re: /\btensorflow\b/i },
  { label: "PyTorch", re: /\bpytorch\b/i },
  { label: "Spring Boot", re: /\bspring\s?boot\b|\bspring\b/i },
  { label: "Django", re: /\bdjango\b/i },
  { label: "Flask", re: /\bflask\b/i },
  { label: "Kafka", re: /\bkafka\b/i },
  { label: "Git", re: /\bgit\b/i },
  { label: "Linux", re: /\blinux\b/i },
  { label: "OOP", re: /\boops?\b/i },
];

function sectionHeaderOf(line: string): Section | null {
  const t = line.trim();
  if (!t || t.length > 40) return null;
  const norm = t.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(work |professional |employment )?experience$|^employment( history)?$|^work history$|^internships?$/.test(norm)) return "experience";
  if (/^(academic |personal |key |major )?projects?$/.test(norm)) return "projects";
  if (/^education(al)?( background| qualifications?)?$|^academics$/.test(norm)) return "education";
  if (/^(technical |key |core )?skills$|^technologies$|^tech stack$/.test(norm)) return "skills";
  if (/^(certifications?|achievements?|awards?|hobbies|interests|languages|summary|objective|declaration|positions? of responsibility)$/.test(norm)) return "other";
  return null;
}

interface TaggedLine {
  text: string;
  section: Section;
  isHeader: boolean;
}

function tagLines(resumeText: string): TaggedLine[] {
  const out: TaggedLine[] = [];
  let current: Section = "none";
  for (const raw of resumeText.split(/\r?\n/)) {
    const header = sectionHeaderOf(raw);
    if (header) {
      current = header;
      out.push({ text: raw.trim(), section: current, isHeader: true });
    } else {
      out.push({ text: raw.trim(), section: current, isHeader: false });
    }
  }
  return out;
}

/** First non-empty line, only if it plausibly IS a name: 2-4 capitalized
 * words, no digits or @, not a "Resume"/"Curriculum Vitae" banner. */
function detectName(lines: TaggedLine[]): string | undefined {
  const first = lines.find((l) => l.text)?.text;
  if (!first || first.length > 48) return undefined;
  if (/[0-9@]/.test(first)) return undefined;
  if (/\b(resume|curriculum|vitae|cv)\b/i.test(first)) return undefined;
  const words = first.split(/\s+/);
  if (words.length < 2 || words.length > 4) return undefined;
  if (!words.every((w) => /^[A-Z][A-Za-z.'-]*$/.test(w))) return undefined;
  return first;
}

interface ExperienceSignals {
  experienced: boolean;
  years?: number;
  workLines: TaggedLine[];
}

function readExperience(lines: TaggedLine[]): ExperienceSignals {
  const allYears = Array.from(
    ("\n" + lines.map((l) => l.text).join("\n")).matchAll(YEAR_RE),
    (m) => Number(m[0]),
  );
  const maxYear = allYears.length ? Math.max(...allYears) : 0;

  let summedYears = 0;
  let hasNonInternTitle = false;
  const workLines: TaggedLine[] = [];

  for (const l of lines) {
    if (l.isHeader || !l.text) continue;
    // Only experience-section lines (or unsectioned lines) can be work history.
    const workContext = l.section === "experience" || l.section === "none";
    if (!workContext || EDU_RE.test(l.text)) continue;

    // Intern lines still name companies (workLines feeds extraction) but never
    // count toward `experienced` — the fresher-with-internship rule.
    const isIntern = INTERN_RE.test(l.text);
    if (TITLE_RE.test(l.text) && !ASPIRATION_RE.test(l.text)) {
      if (!isIntern) hasNonInternTitle = true;
      workLines.push(l);
    }

    for (const m of l.text.matchAll(RANGE_RE)) {
      const start = Number(m[1]);
      const end = /^\d{4}$/.test(m[2]) ? Number(m[2]) : Math.max(maxYear, start + 1);
      const span = Math.min(30, Math.max(0, end - start));
      if (!isIntern) summedYears += span;
      if (!workLines.includes(l)) workLines.push(l);
    }
  }

  const experienced = hasNonInternTitle || summedYears >= 1;
  return {
    experienced,
    years: experienced && summedYears >= 1 ? Math.round(summedYears) : undefined,
    workLines,
  };
}

const COMPANY_SUFFIX_RE = /\b(technologies|technology|solutions|systems|labs|infotech|softwares?|services|consultancy|pvt|ltd|llc|inc|corp|corporation|limited)\b/i;

/** Pull a company name out of one work-history line: prefer "at X", else the
 * first capitalized segment that is not a title, date, or education token. */
function extractCompany(line: string): string | null {
  let s = line
    .replace(/\(.*?\)/g, " ")
    .replace(RANGE_RE, " ")
    .replace(YEAR_RE, " ")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\b/gi, " ");
  const at = s.match(/\bat\s+([A-Z][A-Za-z0-9&.' -]{1,50})/);
  if (at) s = at[1];
  const segs = s
    .split(/,|\||•|·|\t| {2,}|\s[–—-]\s/)
    .map((t) => t.trim().replace(/[.,;:]+$/, ""))
    .filter(Boolean);
  for (const seg of segs) {
    if (TITLE_RE.test(seg) || INTERN_RE.test(seg) || EDU_RE.test(seg)) continue;
    if (/\d/.test(seg) || !/^[A-Z0-9]/.test(seg)) continue;
    const words = seg.split(/\s+/);
    if (words.length < 1 || words.length > 5) continue;
    return seg.slice(0, 60);
  }
  return null;
}

function extractCompanies(workLines: TaggedLine[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of workLines) {
    const c = extractCompany(l.text);
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 4) break;
  }
  return out;
}

function extractSkills(resumeText: string): string[] {
  const out: string[] = [];
  for (const { label, re } of SKILL_DICT) {
    if (re.test(resumeText)) out.push(label);
    if (out.length >= 10) break;
  }
  return out;
}

/** Projects section shape: a non-bullet line ≤ 70 chars starts a project (an
 * inline " — desc" / ": desc" splits into the summary); bullet or long lines
 * feed the current project's summary (first 2 chunks, squashed to ≤ 160). */
function extractProjects(lines: TaggedLine[]): { name: string; summary: string }[] {
  const out: { name: string; summary: string }[] = [];
  let name: string | null = null;
  let chunks: string[] = [];

  const flush = () => {
    if (name && out.length < 3) {
      out.push({ name, summary: chunks.join(" ").replace(/\s+/g, " ").trim().slice(0, 160) });
    }
    name = null;
    chunks = [];
  };

  for (const l of lines) {
    if (l.section !== "projects" || l.isHeader) continue;
    if (!l.text) continue;
    const isBullet = BULLET_RE.test(l.text);
    if (!isBullet && l.text.length <= 70) {
      flush();
      const sep = l.text.match(/^(.{2,60}?)\s*(?:[–—:]|-{2})\s+(.*)$/);
      name = (sep ? sep[1] : l.text).trim().slice(0, 60);
      if (sep) chunks.push(sep[2].trim());
    } else if (name && chunks.length < 2) {
      chunks.push(l.text.replace(BULLET_RE, "").trim());
    }
  }
  flush();
  return out;
}

/** A line is a metric line when it carries a number that is not a bare year —
 * "cut load time 40%" yes, "2021-2023" no. */
function isMetricLine(text: string): boolean {
  if (text.includes("%")) return true;
  const nums = text.match(/\d+(?:\.\d+)?/g);
  return Boolean(nums?.some((n) => !/^(?:19|20)\d{2}$/.test(n)));
}

function pickHighlight(
  lines: TaggedLine[],
  projects: { name: string; summary: string }[],
  skills: string[],
): string | undefined {
  for (const l of lines) {
    if (l.section !== "projects" || l.isHeader || !l.text) continue;
    if (isMetricLine(l.text)) {
      return l.text.replace(BULLET_RE, "").trim().slice(0, 160);
    }
  }
  if (projects.length) return projects[0].name;
  if (skills.length) return skills.slice(0, 3).join(", ");
  return undefined;
}

export function buildResumeProfile(resumeText: string): ResumeProfile {
  const empty: ResumeProfile = { experienced: false, companies: [], skills: [], projects: [] };
  if (!resumeText.trim()) return empty;

  const lines = tagLines(resumeText);
  const name = detectName(lines);
  const exp = readExperience(lines);
  const skills = extractSkills(resumeText);
  const projects = extractProjects(lines);
  const education = lines.find((l) => !l.isHeader && DEGREE_RE.test(l.text))?.text.slice(0, 140);
  const highlight = pickHighlight(lines, projects, skills);

  return {
    ...(name ? { name } : {}),
    experienced: exp.experienced,
    ...(exp.years !== undefined ? { yearsOfExperience: exp.years } : {}),
    companies: extractCompanies(exp.workLines),
    skills,
    projects,
    ...(education ? { education } : {}),
    ...(highlight ? { highlight } : {}),
  };
}
