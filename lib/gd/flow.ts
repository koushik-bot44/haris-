import type { GdHistoryEntry, GdTurn } from "@/lib/types";
import { findTopicSeed, type GdTopicSeed } from "@/lib/fixtures/gd-topics";

// Deterministic scripted debate engine — the GD mock AND the always-on rescue
// (the route falls back here when the CLI brain fails; the client falls back
// here when the route is unreachable). Seeded by topic+candidateName like
// interview-flow.ts — no Math.random, so the same discussion replays the same
// turns for the same history.

export const GD_WRAP_AFTER = 14; // persona turns before the moderator closes
export const MODERATOR_EVERY = 5; // steer cadence (approximate by design)
export const INVITE_AFTER_QUIET = 6; // persona turns without the candidate → invite

// Vikram hogs the floor: two of every four debater slots are his.
const DEBATE_ORDER = ["dominator", "data", "dominator", "fence"] as const;

function hashSeed(s: string): number {
  let seed = 0;
  for (let i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) >>> 0;
  return seed;
}

const STOPWORDS = new Set([
  "that", "this", "with", "have", "will", "would", "could", "should", "about",
  "there", "their", "because", "really", "think", "thing", "things", "just",
  "very", "been", "being", "from", "what", "when", "where", "which", "while",
  "your", "yours", "also", "some", "more", "most", "much", "many", "then",
  "than", "them", "they", "only", "even", "like", "actually", "basically",
  "completely", "honestly", "everyone", "anything", "something",
]);

/** Longest substantive word of the candidate's last point — the echo hook. */
export function keywordOf(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (words.length === 0) return null;
  return words.reduce((a, b) => (b.length > a.length ? b : a));
}

export const GD_WRAP_PREFIX = "Alright, that's time.";

export function isGdWrapTurn(turn: GdTurn): boolean {
  return turn.personaId === "moderator" && turn.text.startsWith(GD_WRAP_PREFIX);
}

export function gdOpening(topic: string, candidateName: string): string {
  return (
    `Welcome, everyone — I'm Anita, and I'll be moderating today. Our topic is "${topic}". ` +
    `${candidateName}, the floor is as much yours as anyone's — jump in whenever you have a point. ` +
    `Vikram, why don't you open?`
  );
}

export function gdWrapup(topic: string, candidateName: string): string {
  return (
    `${GD_WRAP_PREFIX} We heard strong positions on "${topic}" from every corner of the table. ` +
    `Thank you all — and ${candidateName}, thank you for joining us. Let's close here.`
  );
}

/** Custom topics get archetype-true generic stances instead of curated ones. */
function genericStances(topic: string): GdTopicSeed["stances"] {
  return {
    moderator: [
      `Let's take "${topic}" one angle at a time — who is most affected here?`,
      `I'd like to hear a concrete example on this, not just positions.`,
      `Let's test the strongest version of the opposite view for a moment.`,
    ],
    dominator: [
      `On "${topic}" there is exactly one defensible position, and I'm holding it.`,
      `People overcomplicate this — the answer is obvious to anyone paying attention.`,
      `History has already settled this question; we're just catching up.`,
    ],
    data: [
      `Most published numbers on this point the same direction — the trend is hard to argue with.`,
      `Surveys on this consistently show a clear majority forming on one side.`,
      `Chart the last five years on this and the line tells the whole story.`,
    ],
    fence: [
      `There's real merit on both sides of this one.`,
      `The truth is probably situational — context matters more than principle here.`,
      `I'd hesitate to commit fully either way without more specifics.`,
    ],
  };
}

interface ReplayState {
  personaTurns: number;
  quiet: number; // persona turns since the candidate last spoke
  lastSpeaker: string | null;
  echoWord: string | null; // set only when the candidate spoke last
  wrapped: boolean;
}

function replay(history: GdHistoryEntry[]): ReplayState {
  const st: ReplayState = { personaTurns: 0, quiet: 0, lastSpeaker: null, echoWord: null, wrapped: false };
  for (const h of history) {
    if (h.personaId === "candidate") {
      st.quiet = 0;
      st.echoWord = keywordOf(h.text);
    } else {
      st.personaTurns++;
      st.quiet++;
      if (st.echoWord !== null && st.lastSpeaker === "candidate") st.echoWord = null; // already reacted
      if (h.personaId === "moderator" && h.text.startsWith(GD_WRAP_PREFIX)) st.wrapped = true;
    }
    st.lastSpeaker = h.personaId;
  }
  return st;
}

function steerText(stance: string, echoWord: string | null, candidateName: string, pt: number): string {
  const nearTime = pt >= GD_WRAP_AFTER - 3 ? "We're close to time — quick, sharp points now. " : "";
  if (echoWord) return `${nearTime}${candidateName} just raised "${echoWord}" — let's stay with that. ${stance}`;
  return `${nearTime}${stance}`;
}

function inviteText(candidateName: string): string {
  return `${candidateName}, you've been listening carefully — I want your take before we go on. Where do you stand?`;
}

function debaterText(archetype: "dominator" | "data" | "fence", stance: string, echoWord: string | null, variant: number): string {
  if (archetype === "dominator") {
    if (echoWord) return `You said "${echoWord}" — and that's exactly where it falls apart. ${stance} There's no real debate here.`;
    return variant === 0 ? `Let me be blunt: ${stance}` : `${stance} Honestly, there's nothing to debate here.`;
  }
  if (archetype === "data") {
    if (echoWord) return `On "${echoWord}", the numbers actually settle it. ${stance}`;
    return variant === 0 ? stance : `Look at the numbers for a second. ${stance}`;
  }
  if (echoWord) return `The point about "${echoWord}" is fair — partly. ${stance} Though the other side isn't wrong either.`;
  return variant === 0 ? `${stance} That said, I can see the other side too.` : `I'm genuinely torn on this. ${stance}`;
}

export function computeGdTurns(
  topic: string,
  candidateName: string,
  history: GdHistoryEntry[],
  wantTurns: number,
): GdTurn[] {
  if (!Number.isFinite(wantTurns) || wantTurns < 1) return [];
  const want = Math.min(Math.floor(wantTurns), 8);
  const seed = hashSeed(`${topic}|${candidateName}`);
  const stances = findTopicSeed(topic)?.stances ?? genericStances(topic);
  const st = replay(history);
  if (st.wrapped) return [];

  const out: GdTurn[] = [];
  let { personaTurns: pt, quiet, lastSpeaker, echoWord } = st;

  while (out.length < want) {
    if (pt >= GD_WRAP_AFTER) {
      out.push({ personaId: "moderator", text: gdWrapup(topic, candidateName) });
      break;
    }
    let personaId: string;
    let text: string;
    const prevWasModerator = lastSpeaker === "moderator";

    if (pt === 0) {
      personaId = "moderator";
      text = gdOpening(topic, candidateName);
    } else if (!prevWasModerator && quiet >= INVITE_AFTER_QUIET && quiet % MODERATOR_EVERY === 1) {
      personaId = "moderator";
      text = inviteText(candidateName);
    } else if (!prevWasModerator && pt % MODERATOR_EVERY === 2) {
      personaId = "moderator";
      const stance = stances.moderator[(seed + pt) % stances.moderator.length];
      text = steerText(stance, echoWord, candidateName, pt);
    } else {
      let d = DEBATE_ORDER[(pt + (seed % 4)) % 4];
      // Never let a debater answer themselves (adjacent DEBATE_ORDER entries differ).
      if (d === lastSpeaker) d = DEBATE_ORDER[(pt + (seed % 4) + 1) % 4];
      const list = stances[d];
      const stance = list[(seed + pt) % list.length];
      text = debaterText(d, stance, echoWord, (seed + pt) % 2);
      personaId = d;
    }

    out.push({ personaId, text });
    echoWord = null; // the first turn after the candidate carries the reaction
    pt++;
    quiet++;
    lastSpeaker = personaId;
  }
  return out;
}
