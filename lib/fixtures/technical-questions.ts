// Technical-round question banks per role preset (~8 each, the plan's curated
// seed), plus the deterministic coding question per role and the technical
// interviewer persona. The coding question ALWAYS arrives as main question #3
// of a technical round — decided in code, not by the model, so the editor UI
// is reliable.

import type { HrQuestion } from "@/lib/fixtures/hr-questions";
import type { RolePreset } from "@/lib/types";

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
  language: string;
}

export const CODING_QUESTIONS: Record<RolePreset, CodingQuestion> = {
  "java-sde-fresher": {
    id: 900,
    text: "Write a Java method that takes a string and returns the first non-repeating character, or a sensible result when none exists. Explain your complexity in a comment.",
    starter:
      "public class Solution {\n    // Return the first non-repeating character in s.\n    // What should happen when there is none? Decide and document it.\n    public static Character firstNonRepeating(String s) {\n        // your code here\n        return null;\n    }\n}\n",
    language: "java",
  },
  "frontend-fresher": {
    id: 901,
    text: "Write a debounce function in JavaScript — it should delay calling fn until wait milliseconds have passed since the last call. Note one real UI situation where you'd use it.",
    starter:
      "// debounce(fn, wait) -> debounced function\n// Bonus: what should happen if the debounced function is called with different `this`/args?\nfunction debounce(fn, wait) {\n  // your code here\n}\n",
    language: "javascript",
  },
  general: {
    id: 902,
    text: "In any language you like, write a function that checks whether two strings are anagrams of each other. State the time complexity in a comment.",
    starter: "// isAnagram(a, b) -> boolean\n// Consider: case, spaces, unicode — decide and document your rules.\n",
    language: "javascript",
  },
};

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
