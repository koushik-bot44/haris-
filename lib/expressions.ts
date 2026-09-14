import { stripSpeechTags } from "@/lib/speakable";

// Natural interviewer expressions — the small sounds of someone listening,
// thinking and reacting — verified against the voice that actually speaks.
//
// The production voice is Kokoro-82M (on-device); its text goes through an
// espeak-ng phonemizer, and that phonemizer SPELLS OUT anything it does not
// recognise as a word. Measured on 2026-09-14 by synthesising every candidate
// expression with the shipped voices (af_heart / am_michael):
//
//   "Mm"        → ɛm ɛm            "em em"           (spelled out)
//   "Mm-hm"     → ɛm ɛm eɪtʃ ɛm    "em em aitch em"  (spelled out — this was
//                                                       the app's own nudge line)
//   "Mm-hmm"    → ɛm ɛm həm                            (spelled out)
//   "Mhm" / "Hm"→ ɛm eɪtʃ ɛm / eɪtʃ ɛm                  (spelled out)
//   "*laughs*"  → "asterisk laughs asterisk"
//   "(laughs)" / "[laugh]" → the word "laughs" / "laugh"
//
//   "Hmm" (two m's or more) → hˈəm     ✓ a real hum
//   "Uh-huh" → ʌhʌ, "Uh"/"Um" → ʌ/ʌm  ✓
//   "Oh", "Ah", "Huh", "Ha!", "haha", "heh-heh", "Well…", "So…" ✓ real phonemes
//   every full phrase ("Okay, that makes sense.", "Wait, really?") ✓
//
// Two more measured facts shape how expressions are used:
//   * Kokoro pads a lone one-word clip to ~1.3 s of which ~60% is silence, so a
//     reaction spoken as its OWN sentence lands as "reaction + a beat of
//     silence" — that is the pause; joined to the next sentence with a comma or
//     dash it flows straight on. Ellipses and dashes add no pause of their own.
//   * Chatterbox-Turbo (local studio voice) performs paralinguistic tags
//     ([chuckle], [sigh] …) and reads "Mm-hm" naturally; every other engine
//     must get the spellings above and no tags.
//
// Expressions are context-aware and OCCASIONAL: at most one per turn, and only
// where a real interviewer would make that sound.

export type VoiceEngineKind = "chatterbox" | "kokoro" | "system" | "cloud" | "elevenlabs";

export type ReactionContext =
  | "acknowledge" // heard, neutral
  | "agree" // a fair point
  | "impressed" // a strong, specific answer
  | "thinking" // weighing what they said
  | "surprise" // something unexpected
  | "skeptical" // something does not add up
  | "difficult" // before a hard follow-up
  | "clarify" // before restating what they said
  | "deeper" // moving one level down
  | "amused" // they made a genuinely funny remark
  | "honest"; // an honest "I don't know"

interface Expression {
  /** Safe on every engine (verified phonemes on Kokoro). */
  text: string;
  /** Optional Chatterbox-Turbo rendering with a performed tag. */
  chatterbox?: string;
}

const LIBRARY: Record<ReactionContext, Expression[]> = {
  acknowledge: [{ text: "Okay." }, { text: "Right." }, { text: "Got it." }, { text: "Uh-huh." }, { text: "Hmm, okay." }, { text: "I see." }, { text: "Ah, okay." }, { text: "Alright." }],
  agree: [{ text: "Yeah, fair enough." }, { text: "That's a good point." }, { text: "Okay, I follow." }, { text: "Okay, that makes sense." }, { text: "Right, that makes sense." }],
  impressed: [{ text: "Oh, that's interesting." }, { text: "Interesting." }, { text: "Oh, I see." }, { text: "Ah, right." }, { text: "Huh, interesting." }],
  thinking: [{ text: "Hmm." }, { text: "Hmm, okay." }, { text: "Right..." }, { text: "Hmm... I want to come back to that." }, { text: "Okay... so." }],
  surprise: [{ text: "Oh!" }, { text: "Wait, really?" }, { text: "Oh, that's interesting." }, { text: "Huh." }],
  skeptical: [{ text: "Hmm." }, { text: "Hmm, okay..." }, { text: "Right..." }, { text: "Well..." }],
  difficult: [{ text: "Hmm." }, { text: "Okay, let's take that one step further." }, { text: "Alright, let's take that one step further." }, { text: "Hmm... let me push on that a bit." }],
  clarify: [{ text: "Just to clarify..." }, { text: "Let me understand that correctly..." }, { text: "So, you're saying...?" }, { text: "Okay, let me make sure I have that right." }],
  deeper: [{ text: "Okay, let's dig into that." }, { text: "Interesting — tell me more about that." }, { text: "Alright, let's take that one step further." }, { text: "Okay, let's go one level down." }],
  amused: [{ text: "Ha!", chatterbox: "[laugh] Ha!" }, { text: "haha, fair enough.", chatterbox: "[chuckle] Fair enough." }, { text: "heh-heh, okay.", chatterbox: "[chuckle] Okay." }, { text: "That's funny." }],
  honest: [{ text: "That's fine — it's useful to know where the edge is." }, { text: "No problem, that's an honest answer." }, { text: "Okay, thanks for being straight about it." }, { text: "Fair enough, that's honest." }],
};

/** Spellings the production voice reads as letters, and what to say instead. */
const UNSAFE_SPELLINGS: [RegExp, string][] = [
  [/\bmm[- ]?hmm?\b/gi, "Uh-huh"],
  [/\bmhm+\b/gi, "Uh-huh"],
  [/\bhm\b/gi, "Hmm"],
  [/\bmm+\b/gi, "Hmm"],
  [/\bhmm+m*\b/gi, "Hmm"],
];

/** Stage directions no engine performs — read aloud as words otherwise. */
const STAGE_DIRECTIONS = /\*[^*\n]{1,30}\*|\((?:laughs?|chuckles?|sighs?|pauses?|smiles?|nods?|clears throat)\)/gi;

function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** One expression for the moment, varied by seed, rendered for the engine. */
export function reaction(context: ReactionContext, seed: string, engine: VoiceEngineKind = "kokoro"): string {
  const pool = LIBRARY[context];
  const e = pool[hash(`${context}|${seed}`) % pool.length];
  return engine === "chatterbox" && e.chatterbox ? e.chatterbox : e.text;
}

/** Make a line safe for the engine that will speak it: fix the spellings the
 * phonemizer spells out, drop stage directions, and drop performed tags on
 * every engine but Chatterbox. Idempotent. */
export function sanitizeForVoice(text: string, engine: VoiceEngineKind = "kokoro"): string {
  let out = text.replace(STAGE_DIRECTIONS, "");
  if (engine !== "chatterbox") {
    out = stripSpeechTags(out);
    for (const [re, to] of UNSAFE_SPELLINGS) {
      out = out.replace(re, (m) => (m[0] === m[0].toUpperCase() ? to : to.toLowerCase()));
    }
  }
  return out.replace(/ {2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}

/** The prompt line that tells the model which sounds it may make, and when. */
export function expressionsGuidance(engine: VoiceEngineKind = "kokoro"): string {
  const base =
    `You may open with ONE short listening reaction when a real interviewer would make that sound, and usually with none: ` +
    `"Hmm, okay." / "Right." / "Got it." / "Uh-huh." / "I see." (heard you) · "Yeah, fair enough." / "That's a good point." / "Okay, that makes sense." (agree) · ` +
    `"Oh, that's interesting." / "Interesting." (impressed) · "Hmm." / "Hmm... I want to come back to that." (thinking, or something doesn't add up) · ` +
    `"Wait, really?" / "Oh!" (surprise) · "Just to clarify..." / "So, you're saying...?" (before restating them) · "Okay, let's dig into that." (going deeper) · ` +
    `"Ha!" / "haha, fair enough." (only when they were genuinely funny). Join it to your first sentence with a comma or dash to keep momentum; make it its own sentence ("Hmm.") when you want a beat before answering. ` +
    `Never write "Mm-hm", "Mm", "Mhm", "(laughs)" or asterisks — the voice spells those out.`;
  if (engine === "chatterbox") {
    return `${base} This voice also performs at most one of [laugh] [chuckle] [sigh] [gasp] per turn, only where a person would genuinely make that sound.`;
  }
  return base;
}

export const EXPRESSION_CONTEXTS = Object.keys(LIBRARY) as ReactionContext[];
