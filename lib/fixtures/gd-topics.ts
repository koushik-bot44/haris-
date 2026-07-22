// Curated campus-GD topic bank. Each topic ships seed stances per persona
// archetype — the deterministic debate engine rotates through them; the LLM
// provider uses the same topics as grounding. Moderator "stances" are steering
// prompts, not positions (she never takes a side).

export interface GdTopicSeed {
  id: number;
  topic: string;
  stances: {
    moderator: string[];
    dominator: string[];
    data: string[];
    fence: string[];
  };
}

export const GD_TOPICS: GdTopicSeed[] = [
  {
    id: 1,
    topic: "AI will create more jobs than it destroys",
    stances: {
      moderator: [
        "Let's separate the short term from the long term for a moment.",
        "I'd like to hear which sectors we think are most exposed.",
        "Can we ground this in what it means for freshers entering the market this year?",
      ],
      dominator: [
        "Every industrial shift in history has ended with more jobs, not fewer — AI is no different.",
        "The people scared of AI are the ones refusing to reskill, plain and simple.",
        "Companies adopting AI are hiring faster than everyone else — that settles it.",
      ],
      data: [
        "The World Economic Forum's projections put roughly 97 million new roles against 85 million displaced.",
        "When ATMs arrived, teller-adjacent jobs roughly tripled over the next two decades.",
        "Surveys suggest around 60 percent of today's job titles didn't exist in 1940.",
      ],
      fence: [
        "New jobs will come, but the people losing old ones are rarely the ones getting new ones.",
        "It probably creates jobs in aggregate while destroying them locally — both things are true.",
        "The timeline matters — short-term pain can be real even if the long term is positive.",
      ],
    },
  },
  {
    id: 2,
    topic: "Work from home is hurting freshers",
    stances: {
      moderator: [
        "Let's keep this specific to the first two years of a career.",
        "What would a company have to do to make remote work FOR freshers?",
        "I want to hear the small-town perspective on this.",
      ],
      dominator: [
        "A fresher learns by sitting next to seniors — remote work simply cannot replace that.",
        "Every strong engineer I know was forged in an office, full stop.",
        "Freshers demanding remote on day one are choosing comfort over growth.",
      ],
      data: [
        "Studies show onboarding for remote freshers runs about 40 percent longer than in-office.",
        "Mentorship interactions drop by nearly two-thirds when teams go fully remote.",
        "First-year attrition among remote hires is reported at almost twice the in-office rate.",
      ],
      fence: [
        "Offices help mentorship, but remote opens jobs to people far from metro cities.",
        "Hybrid probably captures most of the benefit without the commute cost.",
        "It depends heavily on the manager — a good remote manager beats a bad in-office one.",
      ],
    },
  },
  {
    id: 3,
    topic: "Social media should require ID verification",
    stances: {
      moderator: [
        "Let's weigh abuse reduction against the privacy cost explicitly.",
        "Who holds the ID data — the platform or the government? That changes everything.",
        "Can we hear a view on how this affects political dissent?",
      ],
      dominator: [
        "Anonymity is the root of every troll farm and scam — verify everyone, today.",
        "You need an ID for a SIM card; requiring one for a megaphone to millions is obvious.",
        "Platforms fight verification for one reason: bots inflate their numbers.",
      ],
      data: [
        "Bot researchers estimate up to 15 percent of active accounts on major platforms aren't human.",
        "Countries piloting verification saw reported harassment fall by around a third.",
        "Breach records show identity databases are attacked far more often than ordinary user tables.",
      ],
      fence: [
        "Verification cuts abuse, but it also silences whistleblowers and abuse survivors.",
        "Maybe tiered access — verified for reach, anonymous for reading — splits the difference.",
        "The principle sounds clean; the leak risk of a national ID database is the messy part.",
      ],
    },
  },
  {
    id: 4,
    topic: "Startups are better than MNCs for a fresher's first job",
    stances: {
      moderator: [
        "Let's define 'better' first — learning, money, or long-term options?",
        "How does risk appetite change this answer for someone supporting family?",
        "I'd like a view on the middle path — growth-stage companies.",
      ],
      dominator: [
        "One startup year teaches more than five years in an MNC cubicle — no contest.",
        "MNC training programs are conveyor belts; startups force you to actually build.",
        "Ownership is everything early in a career, and only startups hand it to freshers.",
      ],
      data: [
        "Roughly 90 percent of startups fail within five years — that's the risk a fresher signs up for.",
        "Structured MNC training correlates with stronger fundamentals in year-three assessments.",
        "Startup equity rarely converts — the median payout for early employees is close to zero.",
      ],
      fence: [
        "Startups teach breadth, MNCs teach depth — a fresher needs some of both.",
        "A big brand opens doors that a dead startup on your resume doesn't.",
        "It really depends on the specific team more than the company type.",
      ],
    },
  },
  {
    id: 5,
    topic: "Attendance should be mandatory in engineering colleges",
    stances: {
      moderator: [
        "Let's separate lectures from labs in this argument.",
        "Is the problem attendance policy, or lecture quality?",
        "What would replace attendance as the discipline signal?",
      ],
      dominator: [
        "Discipline precedes learning — remove mandatory attendance and half the class disappears.",
        "Industry demands showing up; college is where that habit is built, period.",
        "Self-paced learning is a myth for eighteen-year-olds — structure is the whole point.",
      ],
      data: [
        "Correlation studies report attendance explaining roughly 30 percent of grade variance.",
        "Colleges that dropped attendance rules saw lecture participation fall under 40 percent.",
        "Placement data shows no significant salary difference by attendance once CGPA is controlled.",
      ],
      fence: [
        "Attendance matters for labs and teamwork, much less for recorded-lecture theory.",
        "Maybe mandate outcomes, not presence — pass the tests however you learn.",
        "Both sides assume all lectures are equal; quality varies wildly.",
      ],
    },
  },
  {
    id: 6,
    topic: "UPI should fully replace cash in India",
    stances: {
      moderator: [
        "Let's talk about the day the network goes down — what then?",
        "Who exactly gets excluded in a fully cashless India?",
        "Can we hear the small-merchant angle on this?",
      ],
      dominator: [
        "Cash is friction, black money, and queues — UPI has already won, finish the job.",
        "Every argument for cash is really an argument for tax evasion.",
        "Billions of transactions a month prove the country is ready — holdouts are nostalgia.",
      ],
      data: [
        "UPI clears over 13 billion transactions a month while cash at point of sale keeps falling.",
        "Roughly a quarter of rural users still face connectivity failures during payments.",
        "Digital trails cut leakage in welfare transfers by double digits in several states.",
      ],
      fence: [
        "Digital for cities, cash as fallback for outages and the unconnected — 'fully' is premature.",
        "Every payments system in the world keeps a cash layer for resilience.",
        "The direction is right; the word 'fully' is doing too much work.",
      ],
    },
  },
  {
    id: 7,
    topic: "Communication matters more than coding for placement success",
    stances: {
      moderator: [
        "Let's distinguish getting placed from growing after placement.",
        "Does this flip between service and product companies?",
        "How should a final-year student split prep time between the two?",
      ],
      dominator: [
        "The best code in the world dies in an interview you can't explain — communication wins, always.",
        "Recruiters decide in the first five minutes, and they're not reading your GitHub in those minutes.",
        "Every placement topper you know is a talker first and a coder second.",
      ],
      data: [
        "Recruiter surveys rank communication in the top two criteria at roughly 70 percent of companies.",
        "At many campuses, HR-round rejections outnumber technical-round rejections.",
        "Career studies show soft-skill ratings predicting promotion speed better than technical scores.",
      ],
      fence: [
        "You need the coding floor to get in the door and communication to walk through it.",
        "For service companies communication dominates; for product companies the bar flips.",
        "It's a multiplier, not a substitute — zero coding times great communication is still zero.",
      ],
    },
  },
  {
    id: 8,
    topic: "Engineering curricula are outdated for today's industry",
    stances: {
      moderator: [
        "Let's separate fundamentals from tooling in this debate.",
        "Whose job is the last mile — colleges or employers?",
        "What one change would each of us make to the syllabus?",
      ],
      dominator: [
        "We teach 1990s syllabi to students entering a 2026 industry — the gap is indefensible.",
        "If colleges did their job, the placement-training industry wouldn't need to exist.",
        "Ask any recruiter: the degree signals patience, not preparation.",
      ],
      data: [
        "Employability surveys put industry-ready engineering graduates near the 50 percent mark.",
        "Curriculum revision cycles average 8 to 10 years while tooling churns every 2.",
        "Companies report 3 to 6 months of retraining before a fresher ships production work.",
      ],
      fence: [
        "Fundamentals age slowly — maybe the core is fine and the electives are stale.",
        "Industry wants today's tools; college teaches how to learn tools — both have a point.",
        "The problem may be delivery and labs more than the syllabus itself.",
      ],
    },
  },
];

export function findTopicSeed(topic: string): GdTopicSeed | null {
  const norm = topic.trim().toLowerCase();
  return GD_TOPICS.find((t) => t.topic.toLowerCase() === norm) ?? null;
}
