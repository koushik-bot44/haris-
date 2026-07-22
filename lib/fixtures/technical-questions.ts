// Technical-round question banks per role preset (~8 each, the plan's curated
// seed), plus the deterministic coding question per role and the technical
// interviewer persona. The coding question ALWAYS arrives as main question #3
// of a technical round — decided in code, not by the model, so the editor UI
// is reliable. Every role's exercise exists in all five CodeLanguages (same
// problem, idiomatic starters) — the candidate picks the language on setup.

import type { HrQuestion } from "@/lib/fixtures/hr-questions";
import type { CodeLanguage, RolePreset } from "@/lib/types";

export const TECH_PERSONA = {
  name: "Arjun Rao",
  title: "Tech Lead, Meridian Corp",
  initials: "AR",
};

export const TECH_GREETING = (name: string) =>
  `Hi ${name}, I'm Arjun Rao, tech lead at Meridian Corp. This round is technical — five questions, one of them hands-on coding. ` +
  `Don't worry about perfect answers; I care how you think. Let's start.`;

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

/** Every role's exercise in every language — same problem per role (same id),
 * five idiomatic starters. */
export const CODING_QUESTIONS_BY_LANG: Record<RolePreset, Record<CodeLanguage, CodingQuestion>> = {
  "java-sde-fresher": FIRST_NON_REPEATING,
  "frontend-fresher": DEBOUNCE,
  general: ANAGRAM,
};

// Compatibility shape: the hook and the scripted flow index by role only —
// each role's default is its pre-multi-language variant (java / javascript).
export const CODING_QUESTIONS: Record<RolePreset, CodingQuestion> = {
  "java-sde-fresher": FIRST_NON_REPEATING.java,
  "frontend-fresher": DEBOUNCE.javascript,
  general: ANAGRAM.javascript,
};

/** The role's exercise in the candidate's chosen language. Missing/junk lang
 * (e.g. stale sessionStorage) falls back to the role's existing default. */
export function codingQuestionFor(role: RolePreset, lang?: CodeLanguage): CodingQuestion {
  const table = CODING_QUESTIONS_BY_LANG[role] ?? CODING_QUESTIONS_BY_LANG.general;
  return (lang && table[lang]) || CODING_QUESTIONS[role] || CODING_QUESTIONS.general;
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

export function technicalBank(role: RolePreset): HrQuestion[] {
  if (role === "java-sde-fresher") return [...JAVA_TECH, ...COMMON_TECH];
  if (role === "frontend-fresher") return [...FRONTEND_TECH, ...COMMON_TECH];
  return COMMON_TECH;
}
