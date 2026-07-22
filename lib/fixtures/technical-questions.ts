// Technical-round question banks per role preset (~8 each, the plan's curated
// seed), plus the deterministic coding question per role and the technical
// interviewer persona. The coding question ALWAYS arrives as main question #3
// of a technical round — decided in code, not by the model, so the editor UI
// is reliable. Every role's exercise exists in all five CodeLanguages (same
// problem, idiomatic starters) — the candidate picks the language on setup.

import type { HrQuestion } from "@/lib/fixtures/hr-questions";
import type { CodeLanguage, RolePreset } from "@/lib/types";

// One identity across every round: Haris, an AI, openly playing the role the
// round calls for. It used to claim to be "Arjun Rao, tech lead at Meridian
// Corp", which is a person who does not exist at a company that does not exist.
export const TECH_PERSONA = {
  name: "Haris",
  title: "AI interviewer · Technical round",
  initials: "H",
};

// Same kickoff shape as the HR round — see the note on GREETING. The technical
// version additionally SELLS the team and the work, which every guide to
// running a technical interview says the interviewer should do up front: the
// candidate is deciding about you too.
export const TECH_GREETING = (name: string) =>
  `Hi ${name}, I'm Haris — an AI interviewer, and for this round I'm playing the technical interviewer. ` +
  `Here's the shape: we'll talk about what you've built, go deep on one project, then there's a hands-on coding bit, and after that I'll ask about your solution and some fundamentals. I'll leave time at the end for your questions, but ask me anything whenever — this goes both ways. ` +
  `I care how you think far more than whether you get it perfect, and I'll say so if I disagree with you. ` +
  `Ready? Tell me what you've been building lately.`;

export const TECH_WRAPUP = (name: string) =>
  `Alright ${name}, that's the technical round done. Good effort — your detailed feedback is coming up now.`;

export const CODING_INTRO =
  "Time for the hands-on question. The editor is open — write your solution there, talk me through it in comments if you like, and submit when ready.";

export interface CodingQuestion {
  id: number;
  text: string;
  starter: string;
  /** Monaco language id — drives the editor mode and the language chip. */
  language: CodeLanguage;
}

// ——— java-sde-fresher: first non-repeating character (id 900) ———

const FIRST_NON_REPEATING: Record<CodeLanguage, CodingQuestion> = {
  java: {
    id: 900,
    text: "Write a Java method that takes a string and returns the first non-repeating character, or a sensible result when none exists. Explain your complexity in a comment.",
    starter:
      "public class Solution {\n    // Return the first non-repeating character in s.\n    // What should happen when there is none? Decide and document it.\n    // Example: firstNonRepeating(\"swiss\") -> 'w'\n    public static Character firstNonRepeating(String s) {\n        // your code here\n        return null;\n    }\n}\n",
    language: "java",
  },
  python: {
    id: 900,
    text: "Write a Python function that takes a string and returns the first non-repeating character, or a sensible result when none exists. Explain your complexity in a comment.",
    starter:
      "# Return the first non-repeating character in s.\n# What should happen when there is none? Decide and document it.\n# Example: first_non_repeating(\"swiss\") -> \"w\"\ndef first_non_repeating(s: str):\n    # your code here\n    pass\n",
    language: "python",
  },
  cpp: {
    id: 900,
    text: "Write a C++ function that takes a string and returns the first non-repeating character, or a sensible result when none exists. Explain your complexity in a comment.",
    starter:
      "#include <string>\n#include <optional>\n\n// Return the first non-repeating character in s.\n// What should happen when there is none? Decide and document it.\n// Example: firstNonRepeating(\"swiss\") -> 'w'\nstd::optional<char> firstNonRepeating(const std::string& s) {\n    // your code here\n    return std::nullopt;\n}\n",
    language: "cpp",
  },
  javascript: {
    id: 900,
    text: "Write a JavaScript function that takes a string and returns the first non-repeating character, or a sensible result when none exists. Explain your complexity in a comment.",
    starter:
      "// Return the first non-repeating character in s.\n// What should happen when there is none? Decide and document it.\n// Example: firstNonRepeating(\"swiss\") -> \"w\"\nfunction firstNonRepeating(s) {\n  // your code here\n  return null;\n}\n",
    language: "javascript",
  },
  c: {
    id: 900,
    text: "Write a C function that takes a string and returns the first non-repeating character, or a sensible result when none exists. Explain your complexity in a comment.",
    starter:
      "/* Return the first non-repeating character in s, or '\\0' when none exists.\n   Example: firstNonRepeating(\"swiss\") -> 'w' */\nchar firstNonRepeating(const char *s) {\n    /* your code here */\n    return '\\0';\n}\n",
    language: "c",
  },
};

// ——— frontend-fresher: debounce (id 901) ———

const DEBOUNCE: Record<CodeLanguage, CodingQuestion> = {
  java: {
    id: 901,
    text: "Write a debounce helper in Java — it should delay running a task until wait milliseconds have passed since the last call. Note one real UI situation where you'd use it.",
    starter:
      "import java.util.concurrent.Executors;\nimport java.util.concurrent.ScheduledExecutorService;\nimport java.util.concurrent.ScheduledFuture;\nimport java.util.concurrent.TimeUnit;\n\n// Debouncer: call(fn) runs fn only after waitMs of quiet — earlier pending runs are cancelled.\n// Example: debouncer.call(this::search) on every keystroke -> search runs once, after typing stops\npublic class Debouncer {\n    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();\n    private final long waitMs;\n    private ScheduledFuture<?> pending;\n\n    public Debouncer(long waitMs) {\n        this.waitMs = waitMs;\n    }\n\n    public synchronized void call(Runnable fn) {\n        // your code here: cancel `pending`, then schedule fn after waitMs\n    }\n}\n",
    language: "java",
  },
  python: {
    id: 901,
    text: "Write a debounce function in Python — it should delay calling fn until the wait interval has passed since the last call. Note one real UI situation where you'd use it.",
    starter:
      "import threading\n\n# debounce(fn, wait) -> debounced function: fn runs only after `wait` seconds of quiet.\n# Example: on_change = debounce(search, 0.3) -> search runs 300ms after typing stops\ndef debounce(fn, wait):\n    def debounced(*args, **kwargs):\n        # your code here: cancel the previous threading.Timer, start a new one\n        pass\n    return debounced\n",
    language: "python",
  },
  cpp: {
    id: 901,
    text: "Write a debounce helper in C++ — it should delay running a callback until wait milliseconds have passed since the last call. Note one real UI situation where you'd use it.",
    starter:
      "#include <chrono>\n#include <functional>\n\n// Debouncer: call(fn) runs fn only after wait ms of quiet since the last call.\n// Example: debouncer.call(search) on every keystroke -> search fires once typing stops\nclass Debouncer {\npublic:\n    explicit Debouncer(std::chrono::milliseconds wait) : wait_(wait) {}\n\n    void call(std::function<void()> fn) {\n        // your code here: remember the call time; run fn only when wait_ has\n        // passed with no newer call (timer thread or polling — your choice)\n    }\n\nprivate:\n    std::chrono::milliseconds wait_;\n};\n",
    language: "cpp",
  },
  javascript: {
    id: 901,
    text: "Write a debounce function in JavaScript — it should delay calling fn until wait milliseconds have passed since the last call. Note one real UI situation where you'd use it.",
    starter:
      "// debounce(fn, wait) -> debounced function\n// Bonus: what should happen if the debounced function is called with different `this`/args?\n// Example: input.oninput = debounce(search, 300) -> search runs 300ms after typing stops\nfunction debounce(fn, wait) {\n  // your code here\n}\n",
    language: "javascript",
  },
  c: {
    id: 901,
    text: "Write the core of a debounce in C — track call times so an action fires only after wait milliseconds have passed since the most recent call. Note one real UI situation where you'd use it.",
    starter:
      "#include <stdbool.h>\n\n/* Debounce core: record each call's time; fire only when wait_ms have\n   passed since the most recent call.\n   Example: calls at t=0,100,200 with wait_ms=300 -> fires once, at t=500 */\ntypedef struct {\n    long wait_ms;\n    long last_call_ms; /* time of the most recent call */\n} debounce_t;\n\n/* Called on every event at time now_ms. */\nvoid debounce_call(debounce_t *d, long now_ms) {\n    /* your code here */\n}\n\n/* Poll: should the debounced action fire now? */\nbool debounce_should_fire(const debounce_t *d, long now_ms) {\n    /* your code here */\n    return false;\n}\n",
    language: "c",
  },
};

// ——— general: anagram check (id 902) ———

const ANAGRAM: Record<CodeLanguage, CodingQuestion> = {
  java: {
    id: 902,
    text: "Write a Java method that checks whether two strings are anagrams of each other. State the time complexity in a comment.",
    starter:
      "public class Solution {\n    // Consider: case, spaces, unicode — decide and document your rules.\n    // Example: isAnagram(\"listen\", \"silent\") -> true\n    public static boolean isAnagram(String a, String b) {\n        // your code here\n        return false;\n    }\n}\n",
    language: "java",
  },
  python: {
    id: 902,
    text: "Write a Python function that checks whether two strings are anagrams of each other. State the time complexity in a comment.",
    starter:
      "# Consider: case, spaces, unicode — decide and document your rules.\n# Example: is_anagram(\"listen\", \"silent\") -> True\ndef is_anagram(a: str, b: str) -> bool:\n    # your code here\n    return False\n",
    language: "python",
  },
  cpp: {
    id: 902,
    text: "Write a C++ function that checks whether two strings are anagrams of each other. State the time complexity in a comment.",
    starter:
      "#include <string>\n\n// Consider: case, spaces, unicode — decide and document your rules.\n// Example: isAnagram(\"listen\", \"silent\") -> true\nbool isAnagram(const std::string& a, const std::string& b) {\n    // your code here\n    return false;\n}\n",
    language: "cpp",
  },
  javascript: {
    id: 902,
    text: "Write a JavaScript function that checks whether two strings are anagrams of each other. State the time complexity in a comment.",
    starter:
      "// isAnagram(a, b) -> boolean\n// Consider: case, spaces, unicode — decide and document your rules.\n// Example: isAnagram(\"listen\", \"silent\") -> true\nfunction isAnagram(a, b) {\n  // your code here\n  return false;\n}\n",
    language: "javascript",
  },
  c: {
    id: 902,
    text: "Write a C function that checks whether two strings are anagrams of each other. State the time complexity in a comment.",
    starter:
      "#include <stdbool.h>\n\n/* Consider: case and spaces — decide and document your rules.\n   Example: isAnagram(\"listen\", \"silent\") -> true */\nbool isAnagram(const char *a, const char *b) {\n    /* your code here */\n    return false;\n}\n",
    language: "c",
  },
};

// ——— pair sum (id 903) ———

const PAIR_SUM: Record<CodeLanguage, CodingQuestion> = {
  java: {
    id: 903,
    text: "Write a Java method that finds two numbers in an array that add up to a target, and returns their indices. State the time complexity in a comment.",
    starter:
      "public class Solution {\n    // Return the indices of the two numbers adding to target.\n    // Decide and document what happens when there is no such pair.\n    // Example: pairSum(new int[]{2,7,11,15}, 9) -> [0, 1]\n    public static int[] pairSum(int[] nums, int target) {\n        // your code here\n        return new int[0];\n    }\n}\n",
    language: "java",
  },
  python: {
    id: 903,
    text: "Write a Python function that finds two numbers in a list that add up to a target, and returns their indices. State the time complexity in a comment.",
    starter:
      "# Return the indices of the two numbers adding to target.\n# Decide and document what happens when there is no such pair.\n# Example: pair_sum([2, 7, 11, 15], 9) -> (0, 1)\ndef pair_sum(nums: list[int], target: int):\n    # your code here\n    return None\n",
    language: "python",
  },
  cpp: {
    id: 903,
    text: "Write a C++ function that finds two numbers in a vector that add up to a target, and returns their indices. State the time complexity in a comment.",
    starter:
      "#include <vector>\n\n// Return the indices of the two numbers adding to target.\n// Decide and document what happens when there is no such pair.\n// Example: pairSum({2, 7, 11, 15}, 9) -> {0, 1}\nstd::vector<int> pairSum(const std::vector<int>& nums, int target) {\n    // your code here\n    return {};\n}\n",
    language: "cpp",
  },
  javascript: {
    id: 903,
    text: "Write a JavaScript function that finds two numbers in an array that add up to a target, and returns their indices. State the time complexity in a comment.",
    starter:
      "// Return the indices of the two numbers adding to target.\n// Decide and document what happens when there is no such pair.\n// Example: pairSum([2, 7, 11, 15], 9) -> [0, 1]\nfunction pairSum(nums, target) {\n  // your code here\n  return [];\n}\n",
    language: "javascript",
  },
  c: {
    id: 903,
    text: "Write a C function that finds two numbers in an array that add up to a target, writing their indices to out params. State the time complexity in a comment.",
    starter:
      "#include <stdbool.h>\n\n/* Write the indices of the two numbers adding to target into *i and *j.\n   Return false when there is no such pair.\n   Example: nums = {2,7,11,15}, target = 9 -> i=0, j=1 */\nbool pair_sum(const int *nums, int n, int target, int *i, int *j) {\n    /* your code here */\n    return false;\n}\n",
    language: "c",
  },
};

// ——— balanced brackets (id 904) ———

const BALANCED_BRACKETS: Record<CodeLanguage, CodingQuestion> = {
  java: {
    id: 904,
    text: "Write a Java method that checks whether a string of brackets is balanced — round, square and curly. State the time complexity in a comment.",
    starter:
      "public class Solution {\n    // Balanced means every opener has a matching closer, correctly nested.\n    // Example: isBalanced(\"{[()]}\") -> true, isBalanced(\"([)]\") -> false\n    public static boolean isBalanced(String s) {\n        // your code here\n        return false;\n    }\n}\n",
    language: "java",
  },
  python: {
    id: 904,
    text: "Write a Python function that checks whether a string of brackets is balanced — round, square and curly. State the time complexity in a comment.",
    starter:
      "# Balanced means every opener has a matching closer, correctly nested.\n# Example: is_balanced(\"{[()]}\") -> True, is_balanced(\"([)]\") -> False\ndef is_balanced(s: str) -> bool:\n    # your code here\n    return False\n",
    language: "python",
  },
  cpp: {
    id: 904,
    text: "Write a C++ function that checks whether a string of brackets is balanced — round, square and curly. State the time complexity in a comment.",
    starter:
      "#include <string>\n\n// Balanced means every opener has a matching closer, correctly nested.\n// Example: isBalanced(\"{[()]}\") -> true, isBalanced(\"([)]\") -> false\nbool isBalanced(const std::string& s) {\n    // your code here\n    return false;\n}\n",
    language: "cpp",
  },
  javascript: {
    id: 904,
    text: "Write a JavaScript function that checks whether a string of brackets is balanced — round, square and curly. State the time complexity in a comment.",
    starter:
      "// Balanced means every opener has a matching closer, correctly nested.\n// Example: isBalanced(\"{[()]}\") -> true, isBalanced(\"([)]\") -> false\nfunction isBalanced(s) {\n  // your code here\n  return false;\n}\n",
    language: "javascript",
  },
  c: {
    id: 904,
    text: "Write a C function that checks whether a string of brackets is balanced — round, square and curly. State the time complexity in a comment.",
    starter:
      "#include <stdbool.h>\n\n/* Balanced means every opener has a matching closer, correctly nested.\n   Example: is_balanced(\"{[()]}\") -> true, is_balanced(\"([)]\") -> false */\nbool is_balanced(const char *s) {\n    /* your code here */\n    return false;\n}\n",
    language: "c",
  },
};

/** Every role's exercise in every language — same problem per role (same id),
 * five idiomatic starters. Kept as the role's DEFAULT; the pool below is what
 * a live interview actually draws from. */
export const CODING_QUESTIONS_BY_LANG: Record<RolePreset, Record<CodeLanguage, CodingQuestion>> = {
  "java-sde-fresher": FIRST_NON_REPEATING,
  "frontend-fresher": DEBOUNCE,
  general: ANAGRAM,
};

/** The problems a role can draw. Before this there was exactly ONE exercise per
 * role, so every candidate on `general` got the anagram question in every
 * session, forever — the single most obviously canned moment in the product. */
export const CODING_POOL: Record<RolePreset, Record<CodeLanguage, CodingQuestion>[]> = {
  "java-sde-fresher": [FIRST_NON_REPEATING, PAIR_SUM, BALANCED_BRACKETS],
  "frontend-fresher": [DEBOUNCE, PAIR_SUM, ANAGRAM],
  general: [ANAGRAM, PAIR_SUM, BALANCED_BRACKETS],
};

// Compatibility shape: the hook and the scripted flow index by role only —
// each role's default is its pre-multi-language variant (java / javascript).
export const CODING_QUESTIONS: Record<RolePreset, CodingQuestion> = {
  "java-sde-fresher": FIRST_NON_REPEATING.java,
  "frontend-fresher": DEBOUNCE.javascript,
  general: ANAGRAM.javascript,
};

/** The role's exercise in the candidate's chosen language. Missing/junk lang
 * (e.g. stale sessionStorage) falls back to the role's existing default.
 *
 * `seed` picks WHICH problem from the role's pool. It has to be stable for the
 * whole of one interview (the editor, the submitted code and the score all
 * reference the same problem) but differ between interviews. There is no
 * session id on the request — the API is stateless by design — so callers pass
 * something already fixed by the time the coding round arrives, in practice the
 * candidate's first answer. No seed keeps the historical default. */
export function codingQuestionFor(
  role: RolePreset,
  lang?: CodeLanguage,
  seed?: string,
): CodingQuestion {
  const pool = CODING_POOL[role] ?? CODING_POOL.general;
  const table = seed
    ? pool[hashIndex(seed, pool.length)]
    : (CODING_QUESTIONS_BY_LANG[role] ?? CODING_QUESTIONS_BY_LANG.general);
  return table[lang ?? DEFAULT_LANG[role] ?? "javascript"] ?? CODING_QUESTIONS.general;
}

/** Language used when the candidate never picked one. Per role, matching the
 * pre-pool defaults — a Java SDE round must not open in JavaScript. */
const DEFAULT_LANG: Record<RolePreset, CodeLanguage> = {
  "java-sde-fresher": "java",
  "frontend-fresher": "javascript",
  general: "javascript",
};

/** The seed both the server and the editor must derive identically, or the
 * interviewer would speak one problem while the editor showed another's
 * starter. Uses the candidate's first answer, which is already fixed by the
 * time the coding round can trigger. */
export function codingSeedFrom(
  candidateName: string,
  history: readonly { speaker: string; text: string }[],
): string {
  const firstAnswer = history.find((h) => h.speaker === "candidate")?.text;
  return `${candidateName}|${firstAnswer ?? ""}`;
}

/** FNV-1a, so the choice is spread evenly over the pool rather than clustering
 * the way a naive character sum does on similar-looking answers. */
function hashIndex(seed: string, mod: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % mod;
}

const COMMON_TECH: HrQuestion[] = [
  {
    id: 101,
    text: "Walk me through a project you actually built — what does it do, and what part did you write yourself?",
    followup: "Pick one function or module in it you're proud of. Why that one?",
    expectKeywords: ["built", "project", "i wrote", "my"],
  },
  {
    id: 102,
    text: "Explain the difference between a process and a thread like I'm a smart junior.",
    followup: "When would using multiple threads actually make a program slower?",
    expectKeywords: ["memory", "process", "thread", "share"],
  },
  {
    id: 103,
    text: "What happens when you type a URL into a browser and press enter? Take me as deep as you can.",
    followup: "Where does caching show up in that journey?",
    expectKeywords: ["dns", "http", "server", "request", "render"],
  },
  {
    id: 104,
    text: "Tell me about a bug that took you a long time to find. How did you finally corner it?",
    followup: "What would you instrument differently so that class of bug shows up in minutes next time?",
    expectKeywords: ["debug", "log", "found", "print", "test"],
  },
  {
    id: 105,
    text: "When would you choose a hash map over an array, and what does that choice cost you?",
    followup: "What's a situation where the array wins outright?",
    expectKeywords: ["lookup", "o(1)", "order", "memory", "hash"],
  },
];

const JAVA_TECH: HrQuestion[] = [
  {
    id: 111,
    text: "Explain the difference between an interface and an abstract class in Java — and when you'd actually reach for each.",
    followup: "Java 8 added default methods to interfaces. Does that make abstract classes pointless?",
    expectKeywords: ["interface", "abstract", "implement", "extend", "default"],
  },
  {
    id: 112,
    text: "What does the JVM's garbage collector actually do, and when can it still let you run out of memory?",
    followup: "What's a memory leak in a garbage-collected language? Give me a concrete Java example.",
    expectKeywords: ["heap", "reference", "collect", "leak", "memory"],
  },
  {
    id: 113,
    text: "HashMap versus ConcurrentHashMap — what breaks if you use the wrong one?",
    followup: "What actually happens inside a HashMap when two keys collide?",
    expectKeywords: ["thread", "concurrent", "bucket", "collision", "safe"],
  },
];

const FRONTEND_TECH: HrQuestion[] = [
  {
    id: 121,
    text: "Explain what happens between changing state in a React component and the pixels updating on screen.",
    followup: "What's a render your user paid for that they didn't need — and how do you find those?",
    expectKeywords: ["render", "state", "virtual", "dom", "diff"],
  },
  {
    id: 122,
    text: "What's the difference between == and === in JavaScript, and why does the answer matter beyond trivia?",
    followup: "Show me a real bug that == would cause and === would prevent.",
    expectKeywords: ["coercion", "type", "strict", "equal"],
  },
  {
    id: 123,
    text: "Your page loads slowly on a cheap phone. Walk me through how you'd find out why.",
    followup: "Pick the single highest-impact fix from what you listed. Why that one first?",
    expectKeywords: ["lighthouse", "bundle", "network", "profile", "lazy", "image"],
  },
];


// ——— DSA bank — the technical round asks DSA + coding ONLY (user directive).
// One uniform bank across roles: the coding slot + resume anchoring carry the
// role/language flavor; these probe how the candidate actually thinks.
export const DSA_QUESTIONS: HrQuestion[] = [
  {
    id: 130,
    text: "You need to find whether two numbers in an array sum to a target. Walk me through your approach and its complexity.",
    followup: "Now the array is sorted — does your approach change, and why?",
    expectKeywords: ["hash", "map", "o(n)", "two pointer", "complexity", "linear"],
  },
  {
    id: 131,
    text: "When would you pick a linked list over an array? Give me a concrete situation, not a definition.",
    followup: "And what does that choice cost you — what gets slower?",
    expectKeywords: ["insert", "delete", "index", "random access", "memory", "o(1)", "o(n)"],
  },
  {
    id: 132,
    text: "Explain how a hash map gets its average O(1) lookup — and when that promise breaks.",
    followup: "How do collisions get handled, and what happens to complexity in the worst case?",
    expectKeywords: ["hash", "bucket", "collision", "chaining", "probing", "o(n)", "load"],
  },
  {
    id: 133,
    text: "How would you check if a string is a palindrome ignoring spaces and case — and what's the complexity?",
    followup: "Do it without creating a cleaned copy of the string. What changes?",
    expectKeywords: ["two pointer", "o(n)", "lower", "reverse", "compare"],
  },
  {
    id: 134,
    text: "What makes recursion the right tool for tree problems? Walk me through finding the height of a binary tree.",
    followup: "What breaks if the tree is a million nodes deep, and how do you defend against it?",
    expectKeywords: ["base case", "recursive", "height", "stack", "overflow", "depth"],
  },
  {
    id: 135,
    text: "You have a million records and need the top ten by score. Sorting everything feels wasteful — what's better?",
    followup: "What's the complexity of your approach versus a full sort?",
    expectKeywords: ["heap", "priority", "o(n log k)", "partial", "quickselect"],
  },
  {
    id: 136,
    text: "Explain the sliding-window technique with a problem where it beats the brute force.",
    followup: "How do you know when a problem is a sliding-window problem at all?",
    expectKeywords: ["window", "subarray", "substring", "o(n)", "contiguous", "expand", "shrink"],
  },
  {
    id: 137,
    text: "A function works but is O(n squared) and too slow. Walk me through how you actually find and fix the bottleneck.",
    followup: "Give me one real trade you'd accept to get to O(n log n) or O(n).",
    expectKeywords: ["nested", "loop", "hash", "sort", "space", "time", "tradeoff"],
  },
  {
    id: 138,
    text: "When is a stack the right structure? Give me two genuinely different problems it solves cleanly.",
    followup: "One of those — what would go wrong if you used a queue instead?",
    expectKeywords: ["lifo", "parenthes", "undo", "call", "dfs", "reverse"],
  },
  {
    id: 139,
    text: "Binary search looks simple but people get it wrong constantly. What are the classic mistakes, and how do you avoid them?",
    followup: "Write the loop condition and the mid calculation out loud — exactly.",
    expectKeywords: ["sorted", "mid", "overflow", "boundary", "off by one", "log"],
  },
];

export function technicalBank(role: RolePreset): HrQuestion[] {
  // Role flavor lives in the coding slot + resume anchoring; the spoken
  // questions are pure DSA for every role.
  void role;
  return [...DSA_QUESTIONS];
}
