// Curated HR question bank — the seed set the plan requires (~10 per role for
// consistency). The mock provider draws from these; the real LLM provider will
// blend them with generated, resume-aware questions in M2.

export interface HrQuestion {
  id: number;
  text: string;
  /** Canned adaptive follow-up used when the answer looks thin (mock provider). */
  followup: string;
  /** Keywords that, when MISSING from the answer, make the follow-up more likely. */
  expectKeywords: string[];
}

export const HR_QUESTIONS: HrQuestion[] = [
  {
    id: 1,
    text: "Tell me about yourself — beyond what's on your resume.",
    followup: "You covered your academics — but what would your closest friend say you're actually like to work with?",
    expectKeywords: ["project", "team", "learn"],
  },
  {
    id: 2,
    text: "Why do you want to join this company specifically?",
    followup: "That could apply to almost any company. What's one thing specific to us that made you apply?",
    expectKeywords: ["because", "company", "culture", "product"],
  },
  {
    id: 3,
    text: "Tell me about a time you worked in a team and things did not go smoothly. What did you do?",
    followup: "You told me what the team did. What did YOU do, specifically?",
    expectKeywords: ["i ", "my ", "conflict", "talked", "resolved"],
  },
  {
    id: 4,
    text: "What is your biggest weakness, and what are you doing about it?",
    followup: "That sounded a little rehearsed. Give me a real example of when that weakness actually cost you something.",
    expectKeywords: ["example", "improve", "working on"],
  },
  {
    id: 5,
    text: "Describe a situation where you had to learn something completely new under time pressure.",
    followup: "How did you decide what NOT to learn, given the deadline?",
    expectKeywords: ["deadline", "learned", "prioritize"],
  },
  {
    id: 6,
    text: "Where do you see yourself in five years?",
    followup: "And if that path doesn't exist at this company after two years — what then?",
    expectKeywords: ["grow", "lead", "learn"],
  },
  {
    id: 7,
    text: "Tell me about a failure you're actually willing to own. What changed afterwards?",
    followup: "What would the people affected by that failure say about how you handled it?",
    expectKeywords: ["failed", "mistake", "learned", "changed"],
  },
  {
    id: 8,
    text: "Why should we hire you over the other candidates interviewing today?",
    followup: "Everyone says hardworking. What's the evidence — something you've done that most candidates here haven't?",
    expectKeywords: ["project", "built", "unlike", "evidence"],
  },
  {
    id: 9,
    text: "How do you handle criticism of your work?",
    followup: "Tell me about the last piece of criticism you received. What did you do that same week?",
    expectKeywords: ["feedback", "example", "changed"],
  },
  {
    id: 10,
    text: "Are you willing to relocate, and how do you feel about it honestly?",
    followup: "What would make relocation genuinely hard for you — and how would you manage that?",
    expectKeywords: ["yes", "family", "manage"],
  },
];

/** Verbal acknowledgments — the latency mask. Spoken client-side the moment an
 * answer ends, before the provider responds. Real interviewers do this. */
export const VERBAL_ACKS = [
  "Mm, okay.",
  "Alright.",
  "I see.",
  "Okay, noted.",
  "Right.",
];

export const GREETING = (name: string) =>
  `Hello ${name}, I'm Priya Sharma, HR at Meridian Corp. Thanks for joining today. ` +
  `This will be a short round — five questions, about ten minutes. Take your time with each answer. Let's begin.`;

export const WRAPUP = (name: string) =>
  `That concludes our round, ${name}. Thank you — you'll see your feedback in just a moment.`;
