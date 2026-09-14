import { questionKey, wasAlreadyAsked } from "@/lib/memory";

// Interview memory, the semantic half: is this question one we already asked
// in other words, and did the candidate already answer it?
//
// "Same topic" and "same question" are different things. Another question
// about Java is fine; "why did you choose Java?" again, after they explained
// why, is the single most damaging thing an interviewer can do — it says the
// answer was not heard. Exact matching (lib/memory wasAlreadyAsked) catches a
// verbatim repeat; this module catches the rewording, and the follow-up whose
// answer is already in the transcript.
//
// Deliberately conservative: a false "duplicate" costs one regeneration, but a
// false "already answered" could block a legitimately deeper question, so both
// checks need several shared content words before they fire.

/** Question scaffolding and glue that carries no content. */
const STOP = new Set(
  (
    "a an the and or but of to in on at for with by from about as into like through after over between out against during without before under around among " +
    "is are was were be been being am do does did done have has had having can could would should will shall may might must " +
    "i you he she it we they me him her us them my your his its our their this that these those what which who whom whose why how when where whether " +
    "tell me walk explain describe give share talk say mention example specific concrete exactly actually really just quite little bit more most much many some any " +
    "one thing things part parts way ways kind sort something anything everything nothing there here then than so if not no yes okay ok right well " +
    "lets let please could can would you your youve youre im its thats theres whats hows again now still ever never also maybe perhaps only own yourself myself personally " +
    "went go going get got take took make made use used using work worked working try tried down up off back out over"
  ).split(/\s+/),
);

const QUESTION_WORDS = new Set(["why", "how", "what", "which", "when", "where", "who", "whether"]);

/** Irregular forms the suffix stemmer cannot reach. */
const IRREGULAR: Record<string, string> = {
  built: "build",
  chose: "choose",
  chosen: "choose",
  wrote: "write",
  written: "write",
  led: "lead",
  ran: "run",
  found: "find",
  learnt: "learn",
  taught: "teach",
  thought: "think",
  dealt: "deal",
  kept: "keep",
  held: "hold",
  broke: "break",
  broken: "break",
  began: "begin",
  begun: "begin",
  grew: "grow",
  spent: "spend",
  sent: "send",
  meant: "mean",
  people: "person",
  bugs: "bug",
  apis: "api",
  hardest: "hard",
  harder: "hard",
  toughest: "hard",
  tough: "hard",
  difficult: "hard",
  challenging: "hard",
  challenge: "hard",
};

/** Words an interviewer and a candidate use interchangeably. Applied after
 * stemming, so "picked" and "choose" meet in the middle. */
const SYNONYMS: Record<string, string> = {
  pick: "choose",
  select: "choose",
  opt: "choose",
  prefer: "choose",
  decid: "choose",
  decide: "choose",
  creat: "build",
  create: "build",
  develop: "build",
  implement: "build",
  write: "build",
  code: "build",
  fix: "solve",
  resolv: "solve",
  resolve: "solve",
  debug: "solve",
  issue: "problem",
  reason: "why",
  motiv: "why",
  motive: "why",
};

function stem(word: string): string {
  const irregular = IRREGULAR[word];
  if (irregular) return SYNONYMS[irregular] ?? irregular;
  let w = word;
  if (w.length > 4) {
    w = w
      .replace(/(ization|isation)$/, "ize")
      .replace(/(ations?|tions?)$/, "t")
      .replace(/(ness|ment|ity)$/, "")
      .replace(/(ies)$/, "y")
      .replace(/(ing|ed|es|er|ly)$/, "")
      .replace(/s$/, "");
  }
  return SYNONYMS[w] ?? w;
}

/** The content terms of a sentence: lower-cased, scaffolding removed, stemmed.
 * Tech tokens with symbols ("c++", "o(n)", "node.js") survive intact. */
export function contentTerms(text: string): Set<string> {
  const out = new Set<string>();
  const cleaned = text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/'(s|re|ve|ll|d|m)\b/g, "")
    .replace(/n't\b/g, "")
    .replace(/[^a-z0-9+#.()/ -]+/g, " ");
  for (const raw of cleaned.split(/[\s,]+/)) {
    const w = raw.replace(/^[.()/-]+|[.()/-]+$/g, "");
    if (w.length < 3 && !/[+#]/.test(w)) continue;
    if (STOP.has(w) || QUESTION_WORDS.has(w)) continue;
    out.add(/[+#().]/.test(w) ? w : stem(w));
  }
  return out;
}

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = shared(a, b);
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** The asking part of an interviewer turn — sentences that end in "?"; the
 * whole text when it has none. Reactions ("That's a fair point.") must not
 * count towards similarity. */
export function askingPart(text: string): string {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const asks = sentences.filter((s) => s.trim().endsWith("?"));
  return (asks.length ? asks : sentences).join(" ");
}

/** Is `question` a rewording of a question already asked? */
export function isSameQuestion(question: string, asked: readonly string[]): boolean {
  if (!question.trim()) return false;
  if (wasAlreadyAsked(question, asked)) return true;
  const q = contentTerms(askingPart(question));
  if (q.size < 2) return false;
  for (const prior of asked) {
    const p = contentTerms(askingPart(prior));
    if (p.size < 2) continue;
    const common = shared(q, p);
    const sim = jaccard(q, p);
    const smaller = Math.min(q.size, p.size);
    const larger = Math.max(q.size, p.size);
    // Enough shared substance that two different questions are unlikely: three
    // common terms at half overlap; two when both are short; or one short
    // question wholly contained in a slightly longer one.
    if ((common >= 4 && sim >= 0.4) || (common >= 3 && sim >= 0.5) || (common >= 2 && sim >= 0.75) || (common >= 2 && common === smaller && larger <= 5)) return true;
  }
  return false;
}

/** A question that asks for reasons or mechanics — answered only by an
 * explanation, not by the subject being mentioned. */
const WHY_HOW = /\b(why|how|what made|reason|what led)\b/i;
/** A question that explicitly asks for MORE than was said — never "answered". */
const DEEPENING = /\b(more about|in more detail|more detail|walk me through|step by step|deeper|elaborate|expand on|go into|one level down|tell me more)\b/i;
const EXPLANATORY = /\b(because|since|so that|so i|so we|so the|so it|that's why|which is why|the reason|by adding|by using|by making|by writing|by putting|in order to|to avoid|to make sure|instead of|rather than|otherwise|what happened was|turned out|ended up|the idea was|the problem was|the issue was)\b/i;

/** Does one of the candidate's recent answers already cover what `question`
 * asks? Two ways in: nearly every content term of the question appears in one
 * answer ("why did you choose Spring Boot?" after "I chose Spring Boot
 * because…"), or the question asks why/how and one sentence of the answer
 * both mentions its subject and explains something. A one-term question ("How
 * did you test it?") is too generic to judge and never matches. Returns the
 * answer that covers it, or null. */
export function alreadyAnswered(question: string, answers: readonly string[]): string | null {
  const asking = askingPart(question);
  const q = contentTerms(asking);
  if (q.size < 2) return null;
  if (DEEPENING.test(asking)) return null;
  const whyHow = WHY_HOW.test(asking);
  for (const answer of answers) {
    const a = contentTerms(answer);
    if (a.size < 4) continue;
    const covered = shared(q, a);
    // Mentioning the subject answers a "what/which" question; a "why/how"
    // question needs the explanation itself (checked below).
    if (!whyHow && ((q.size <= 3 && covered === q.size) || (q.size > 3 && covered / q.size >= 0.75))) return answer;
    if (whyHow && covered >= Math.max(2, Math.ceil(q.size / 2))) {
      const sentences = answer.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (!EXPLANATORY.test(s)) continue;
        if (shared(q, contentTerms(s)) >= Math.max(2, Math.ceil(q.size / 2))) return answer;
      }
    }
  }
  return null;
}

/** Repetition inside one interview, for reports and tests: exact and reworded
 * question pairs. */
export function findRepeats(questions: readonly string[]): { exact: [number, number][]; reworded: [number, number][] } {
  const exact: [number, number][] = [];
  const reworded: [number, number][] = [];
  for (let i = 0; i < questions.length; i++) {
    for (let j = i + 1; j < questions.length; j++) {
      if (questionKey(questions[i]) === questionKey(questions[j])) exact.push([i, j]);
      else if (isSameQuestion(questions[j], [questions[i]])) reworded.push([i, j]);
    }
  }
  return { exact, reworded };
}
