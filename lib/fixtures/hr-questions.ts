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

// ——— Real-HR canon banks (resume-profile aware) ———
// The questions every placement-interview video runs on, split on
// ResumeProfile.experienced. The scripted fallback draws from these verbatim —
// readPosition attributes turns by exact text, so every string below must stay
// unique across ALL banks and DEEP_PROBES. HR_QUESTIONS above remains the
// no-resume default.

export const FRESHER_HR_QUESTIONS: HrQuestion[] = [
  {
    id: 201,
    text: "Tell me about yourself — a quick introduction in your own words.",
    followup: "That was mostly academics. Tell me one thing about you that isn't written on the resume.",
    expectKeywords: ["project", "learn", "team"],
  },
  {
    id: 202,
    text: "What would you say is your biggest strength — and which of your projects actually proves it?",
    followup: "Anyone can claim that. In that project, what exactly did the strength change?",
    expectKeywords: ["project", "built", "example"],
  },
  {
    id: 203,
    text: "Why do you want to join our company, out of everyone hiring this season?",
    followup: "That answer fits any company. Give me one reason that's specific to us.",
    expectKeywords: ["company", "culture", "product", "because"],
  },
  {
    id: 204,
    text: "Are you open to relocating if the role needs it? Be honest with me.",
    followup: "What would genuinely make relocation hard for you, and how would you handle it?",
    expectKeywords: ["yes", "family", "move"],
  },
  {
    id: 205,
    text: "As a fresher, what are your expectations on the package? I'll only ask this once.",
    followup: "Fair enough. And if our offer comes in a little below that number, what happens?",
    expectKeywords: ["standard", "open", "learn", "growth"],
  },
  {
    id: 206,
    text: "Where do you see yourself three to five years from now?",
    followup: "And what are you doing in the next six months to actually get there?",
    expectKeywords: ["grow", "learn", "lead"],
  },
  {
    id: 207,
    text: "Tell me about a time your team disagreed with you. What did you do?",
    followup: "What did YOU personally change after that disagreement?",
    expectKeywords: ["listen", "talked", "agreed", "i "],
  },
  {
    id: 208,
    text: "Why should we pick you over the other freshers interviewing today?",
    followup: "Everyone here works hard. What's one thing you've built that most of them haven't?",
    expectKeywords: ["project", "built", "because"],
  },
  {
    id: 209,
    text: "What do you do when you're stuck on something you've never seen before?",
    followup: "Tell me about the last time that actually happened. What did you try first?",
    expectKeywords: ["search", "ask", "docs", "tried"],
  },
];

export const EXPERIENCED_HR_QUESTIONS: HrQuestion[] = [
  {
    id: 301,
    text: "So, why are you looking to leave your current company?",
    followup: "Would your current manager be surprised to hear you're interviewing today?",
    expectKeywords: ["growth", "learn", "role", "because"],
  },
  {
    id: 302,
    text: "Walk me through why you changed companies when you did — what drove each move?",
    followup: "If the same reason shows up here in a year, do you move again?",
    expectKeywords: ["growth", "opportunity", "role", "team"],
  },
  {
    id: 303,
    text: "Let's talk numbers — what is your current CTC, and what are you expecting from us?",
    followup: "That was a vague range. I need a real number, and how you justify it.",
    expectKeywords: ["lakh", "lpa", "ctc", "current", "expect"],
  },
  {
    id: 304,
    text: "What's your notice period, and is there any flexibility in it?",
    followup: "If we needed you a month earlier than that, what would you actually do?",
    expectKeywords: ["days", "month", "negoti", "buyout"],
  },
  {
    id: 305,
    text: "Beyond the title, what do you expect this role to give you that your current one doesn't?",
    followup: "And if that expectation isn't met in the first year — then what?",
    expectKeywords: ["growth", "ownership", "learn", "scope"],
  },
  {
    id: 306,
    text: "Why should we hire you over an internal candidate who already knows our systems?",
    followup: "That's what you bring. What will your ramp-up honestly cost us?",
    expectKeywords: ["experience", "perspective", "built", "deliver"],
  },
  {
    id: 307,
    text: "Give me the two-minute version of your professional journey so far.",
    followup: "Which single decision in that journey would you take back?",
    expectKeywords: ["joined", "worked", "built", "moved"],
  },
  {
    id: 308,
    text: "What would your current manager say is the one thing you still need to work on?",
    followup: "And what have you actually done about it in the last three months?",
    expectKeywords: ["feedback", "improve", "working"],
  },
  {
    id: 309,
    text: "Where do you see yourself in five years — realistically, from where you are now?",
    followup: "Does this role actually move you toward that, or is it a detour?",
    expectKeywords: ["lead", "grow", "architect", "manage"],
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

// No question count in the greeting: promising "five questions" primes the
// candidate to experience a form, and the interview no longer runs on a fixed
// count anyway — it goes where the conversation goes.
//
// Honest about what it is. This used to introduce itself as "Priya Sharma, HR
// at Meridian Corp" — a fabricated human at a fabricated company. Haris is an
// AI that is PLAYING an interviewer, and says so.
// Shaped like a real interviewer's kickoff. The best-documented one in the wild
// (jacobian.org/2018/nov/29/annotated-interview-kickoff-script) covers seven
// things before the first question: who I am, thanks, what kind of interview
// this is, that there are no right answers, roughly how many questions, how
// long, and where your questions fit — plus a warning that I will dig in.
// Guides add a consent check ("Sound good?"), which hands the candidate a turn
// inside the first minute.
//
// The stated reason is anxiety, not manners: most people have had little
// practice being interviewed, so normal things feel strange unless flagged.
// That goes double for a fresher on their first campus round, which is exactly
// who uses this.
export const GREETING = (name: string) =>
  `Hi ${name}, I'm Haris — an AI interviewer, and for this round I'm playing the HR interviewer, so treat it like the real thing. ` +
  `We've got about ten minutes. I'll ask about your background and your projects, then how you work with people, and I'll leave time at the end for anything you want to ask me — though honestly, jump in whenever, this is meant to go both ways. ` +
  `There are no right answers, and I'll dig into what you say rather than just moving on. Sound alright? ` +
  `Then let's start with you — tell me a bit about yourself and what you've been building.`;

export const WRAPUP = (name: string) =>
  `That concludes our round, ${name}. Thank you — you'll see your feedback in just a moment.`;
