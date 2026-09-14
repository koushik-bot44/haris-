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

type Section = "none" | "experience" | "internships" | "projects" | "education" | "skills" | "other";

// "present"/"current" endpoints resolve against the max year in the document
// (not the wall clock) so the function stays pure and replays byte-identical.
// Optional month tokens on either side ("Jun 2022 – Dec 2023") are captured
// so spans can be counted in months, not just whole years.
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";
const RANGE_SRC = `\\b(?:(${MONTH})\\s+)?((?:19|20)\\d{2})\\s*(?:[-–—]|to|until)\\s*(?:(${MONTH})\\s+)?((?:19|20)\\d{2}|present|current|now|date|today|ongoing)\\b`;
const RANGE_RE = new RegExp(RANGE_SRC, "gi");
/** Non-global twin for .test() — a /g regex carries lastIndex state. */
const RANGE_TEST_RE = new RegExp(RANGE_SRC, "i");
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Role NOUNS only — "engineering" is a discipline ("Computer Science and
// Engineering"), never a job.
const TITLE_RE =
  /\b(engineer|developer|sde|swe|programmer|consultant|analyst|architect|tech lead|team lead|manager|devops|administrator|scientist|intern(ship)?s?|trainee|associate|specialist|executive|designer|officer)\b/i;
const INTERN_RE = /\bintern(ship)?s?\b/i;
// Objective/summary phrasing that mentions a title without holding it.
const ASPIRATION_RE =
  /\b(aspiring|seeking|looking for|passionate|objective|fresher|to become|to work|wish|want to|aim(?:ing)?|career goal|opportunity to)\b/i;
const EDU_RE =
  /\b(b\.?tech|b\.e\.?|m\.?tech|m\.e\.?|b\.?sc|m\.?sc|bca|mca|mba|ph\.?d|bachelor|master|diploma|university|college|institute|school|cgpa|gpa|matriculation|secondary|degree|computer science|information technology|electronics|department|branch|semester|class of|class\s+(?:x|xii|10|12)|percentage|marks|cbse|icse|hsc|ssc)\b/i;
const DEGREE_RE = /\b(b\.?tech|b\.e\.?|m\.?tech|m\.e\.?|b\.?sc|m\.?sc|bca|mca|mba|ph\.?d|bachelor(?:'s)?|master(?:'s)?)\b/i;
const BULLET_RE = /^\s*(?:[-•*·◦▪‣→]|\d+[.)])\s*/;
/** A numbered heading ("1. Campus Cart") is a project start, not a bullet. */
const NUMBERED_HEADING_RE = /^\s*\d+[.)]\s+[A-Z]/;
/** Project-metadata lines that are never project names or highlights. */
const META_RE =
  /^\s*(?:[-•*·◦▪‣→]\s*)?(tech(?:nology|nologies| stack| used)?|tools?|stack|duration|links?|github|repo(?:sitory)?|live|demo|role|team(?: size)?|technologies used|built with|languages?|url|website)\s*[:\-–—]/i;
const URL_RE = /https?:\/\/|www\.|github\.com|\.io\b|\.dev\b/i;
/** Words that mark a first line as a headline, not a person's name. */
const NOT_A_NAME_RE = /\b(software|engineer|developer|student|fresher|profile|summary|objective|resume|curriculum|vitae|cv|portfolio|contact|email|phone)\b/i;

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
  // The framework, never the season ("Spring 2024").
  { label: "Spring Boot", re: /\bspring\s?boot\b|\bspring\s+(?:framework|mvc|data|security|cloud)\b/i },
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
  if (/^internships?$|^internship experience$/.test(norm)) return "internships";
  if (/^(work |professional |employment |industry )?experience$|^employment( history)?$|^work history$/.test(norm)) return "experience";
  if (/^(academic |personal |key |major |mini |selected )?projects?$/.test(norm)) return "projects";
  if (/^(education(al)?|academics?|academic (background|qualifications?)|qualifications?)( background| qualifications?| details)?$/.test(norm)) {
    return "education";
  }
  if (/^(technical |key |core |programming )?skills$|^technologies$|^tech stack$|^technical proficienc(y|ies)$/.test(norm)) return "skills";
  // Contains-match: "Professional Summary", "Career Objective", "Co-curricular Activities"…
  if (
    /(summary|objective|profile|declaration|achievement|certification|award|hobbies|interest|language|activit|extracurricular|responsibilit|reference|strength|personal details)/.test(
      norm,
    )
  ) {
    return "other";
  }
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
 * words, no digits or @, not a banner, headline, job title or section word. */
function detectName(lines: TaggedLine[]): string | undefined {
  const first = lines.find((l) => l.text)?.text;
  if (!first || first.length > 48) return undefined;
  if (/[0-9@|:/]/.test(first)) return undefined;
  if (NOT_A_NAME_RE.test(first) || TITLE_RE.test(first) || EDU_RE.test(first) || sectionHeaderOf(first)) return undefined;
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

function monthIndex(m: string | undefined): number | null {
  if (!m) return null;
  const i = MONTHS.indexOf(m.slice(0, 3).toLowerCase());
  return i === -1 ? null : i;
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
  // The intern flag of the entry the current line belongs to: set by the
  // entry's title line, cleared by a blank line or a section header — so a
  // date-only continuation line under "Software Engineering Intern" is still
  // an internship, never counted as work experience.
  let entryIntern: boolean | null = null;

  for (const l of lines) {
    if (l.isHeader || !l.text) {
      entryIntern = null;
      continue;
    }
    // Only experience-section lines (or unsectioned lines) can be work history.
    const workContext = l.section === "experience" || l.section === "internships" || l.section === "none";
    if (!workContext || EDU_RE.test(l.text)) continue;

    const lineIntern = INTERN_RE.test(l.text) || l.section === "internships";
    const hasTitle = TITLE_RE.test(l.text) && !ASPIRATION_RE.test(l.text);
    if (hasTitle) {
      entryIntern = lineIntern;
      // Intern lines still name companies (workLines feeds extraction) but never
      // count toward `experienced` — the fresher-with-internship rule.
      if (!lineIntern) hasNonInternTitle = true;
      workLines.push(l);
    }
    const isIntern = lineIntern || Boolean(entryIntern);

    for (const m of l.text.matchAll(RANGE_RE)) {
      const start = Number(m[2]);
      const endIsYear = /^\d{4}$/.test(m[4]);
      const end = endIsYear ? Number(m[4]) : Math.max(maxYear, start + 1);
      let span = end - start;
      const m1 = monthIndex(m[1]);
      const m2 = monthIndex(m[3]);
      if (endIsYear && m1 !== null && m2 !== null) span += (m2 - m1) / 12;
      span = Math.min(30, Math.max(0, span));
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

const COMPANY_SUFFIX_RE =
  /\b(technologies|technology|solutions|systems|labs|infotech|softwares?|services|consultancy|consulting|pvt|ltd|llc|inc|corp|corporation|limited|group|networks|digital|analytics|innovations?|enterprises?|industries)\b/i;
/** Places are not employers — "your time at Bangalore" is a greeting nobody wants. */
const LOCATION_RE =
  /\b(india|usa|u\.s\.a?|uk|remote|hybrid|on-?site|bangalore|bengaluru|hyderabad|chennai|mumbai|pune|delhi|new delhi|noida|gurgaon|gurugram|kolkata|kochi|cochin|ahmedabad|jaipur|indore|coimbatore|vizag|visakhapatnam|vijayawada|nagpur|bhopal|lucknow|chandigarh|mysore|mysuru|trivandrum|thiruvananthapuram|kerala|karnataka|tamil nadu|telangana|andhra pradesh|maharashtra|gujarat|rajasthan|punjab|haryana|west bengal|odisha|bihar|madhya pradesh|uttar pradesh)\b/i;

/** Pull a company name out of one work-history line: a segment with a company
 * suffix wins, then an "at X" capture, then the first capitalized segment that
 * is not a title, date, education token or place. */
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
  const candidates: string[] = [];
  for (const seg of segs) {
    if (TITLE_RE.test(seg) || INTERN_RE.test(seg) || EDU_RE.test(seg) || LOCATION_RE.test(seg)) continue;
    if (/\d/.test(seg) || !/^[A-Z0-9]/.test(seg)) continue;
    const words = seg.split(/\s+/);
    if (words.length < 1 || words.length > 5) continue;
    candidates.push(seg.slice(0, 60));
  }
  if (candidates.length === 0) return null;
  return candidates.find((c) => COMPANY_SUFFIX_RE.test(c)) ?? candidates[0];
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

/** Projects section shape: a non-bullet line ≤ 70 chars (or a numbered
 * heading) starts a project (an inline " — desc" / ": desc" splits into the
 * summary); bullet or long lines feed the current project's summary (first 2
 * chunks, squashed to ≤ 160). Metadata lines ("Tech stack: …"), links and
 * date ranges are neither names nor summaries. Names are deduped. */
function extractProjects(lines: TaggedLine[]): { name: string; summary: string }[] {
  const out: { name: string; summary: string }[] = [];
  const seen = new Set<string>();
  let name: string | null = null;
  let chunks: string[] = [];

  const flush = () => {
    if (name && out.length < 3) {
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ name, summary: chunks.join(" ").replace(/\s+/g, " ").trim().slice(0, 160) });
      }
    }
    name = null;
    chunks = [];
  };

  const startProject = (raw: string) => {
    flush();
    const sep = raw.match(/^(.{2,60}?)\s*(?:[–—:]|-{2})\s+(.*)$/);
    name = (sep ? sep[1] : raw).trim().slice(0, 60);
    if (sep) chunks.push(sep[2].trim());
  };

  for (const l of lines) {
    if (l.section !== "projects" || l.isHeader) continue;
    if (!l.text) continue;
    if (META_RE.test(l.text) || URL_RE.test(l.text) || RANGE_TEST_RE.test(l.text)) continue;
    if (NUMBERED_HEADING_RE.test(l.text) && l.text.length <= 70) {
      startProject(l.text.replace(/^\s*\d+[.)]\s+/, ""));
      continue;
    }
    const isBullet = BULLET_RE.test(l.text);
    if (!isBullet && l.text.length <= 70) {
      startProject(l.text);
    } else if (name && chunks.length < 2) {
      chunks.push(l.text.replace(BULLET_RE, "").trim());
    }
  }
  flush();
  return out;
}

/** Numbers glued to letters are versions and names (HTML5, CSS3, ES6, EC2),
 * ordinals are not metrics either. */
const GLUED_NUMBER_RE = /\b[A-Za-z]+\d+[A-Za-z]*\b|\b\d+(?:st|nd|rd|th)\b/g;
/** A number followed by something that makes it an outcome. */
const IMPACT_AFTER_RE =
  /\d+(?:\.\d+)?\s*(?:%|x\b|k\b|m\b|million|thousand|lakh|crore|users?|students?|customers?|clients?|requests?|rps|qps|ms\b|seconds?|minutes?|hours?|days?|weeks?|downloads?|installs?|stars?|views?|orders?|transactions?|records?|rows?|entries|images?|documents?|accuracy|precision|recall|latency|throughput|uptime|faster|slower|fewer|less|more|reduc\w*|improv\w*|increas\w*|cut\b|boost\w*|sav\w*)/i;
/** An outcome verb followed (soon) by a number. */
const IMPACT_BEFORE_RE =
  /\b(reduced|improved|increased|cut|boosted|saved|handled|served|processed|achieved|scored|reached|grew|scaled|supported|delivered|trained|classified|detected)\b\D{0,24}\d/i;

/** A line is a metric line when it carries a number that is an OUTCOME —
 * "cut load time 40%" yes; "2021-2023", "HTML5", "Duration: 3 months" no. */
function isMetricLine(text: string): boolean {
  const body = text.replace(BULLET_RE, "");
  if (META_RE.test(body) || URL_RE.test(body) || RANGE_TEST_RE.test(body)) return false;
  if (body.includes("%")) return true;
  const t = body.replace(GLUED_NUMBER_RE, " ").replace(YEAR_RE, " ");
  return IMPACT_AFTER_RE.test(t) || IMPACT_BEFORE_RE.test(t);
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
