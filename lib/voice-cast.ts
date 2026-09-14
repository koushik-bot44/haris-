// Voice casting across EVERY engine — pure, shared by server and client.
//
// The app speaks through six personas (two 1:1 interviewers, four GD
// participants). Each engine names voices differently (ElevenLabs ids, OpenAI
// names, Deepgram model ids, Kokoro ids, Chatterbox wav files), so the client
// asks for a persona KEY and the engine resolves it here. Legacy wav filenames
// (lib/voices.ts) still resolve through the reverse map, so nothing that sent
// "Emily.wav" breaks.

import { GD_PERSONA_VOICES, INTERVIEWER_VOICES } from "@/lib/voices";

export const VOICE_KEYS = ["hr", "technical", "moderator", "dominator", "data", "fence"] as const;
export type VoiceKey = (typeof VOICE_KEYS)[number];

export const CLOUD_TTS_ENGINES = ["elevenlabs", "openai", "deepgram", "groq", "gemini"] as const;
export type CloudTtsEngine = (typeof CLOUD_TTS_ENGINES)[number];

export function isVoiceKey(v: string): v is VoiceKey {
  return (VOICE_KEYS as readonly string[]).includes(v);
}

export function isCloudTtsEngine(v: string): v is CloudTtsEngine {
  return (CLOUD_TTS_ENGINES as readonly string[]).includes(v);
}

/** Per-engine voice ids. Every row is a distinct voice on that engine so the
 * GD room keeps four recognisable participants wherever it runs. Ids are the
 * providers' documented premade voices (verified against their docs
 * 2026-08-24). Interviewer voices can be overridden per engine via env. */
export const VOICE_CAST: Record<CloudTtsEngine | "kokoro", Record<VoiceKey, string>> = {
  elevenlabs: {
    hr: "EXAVITQu4vr4xnSDxMaL", // Sarah — warm, professional
    technical: "JBFqnCBsd6RMkjVDRZzb", // George — measured, male
    moderator: "XrExE9yKIg1WjnnlVkGX", // Matilda
    dominator: "pNInz6obpgDQGcFmaJgB", // Adam — assertive
    data: "pFZP5JQG7iQjIQuC4Bku", // Lily
    fence: "TX3LPaxmHKxFdv7VOQHJ", // Liam
  },
  openai: {
    hr: "marin",
    technical: "cedar",
    moderator: "sage",
    dominator: "onyx",
    data: "shimmer",
    fence: "echo",
  },
  deepgram: {
    hr: "aura-2-thalia-en",
    technical: "aura-2-orpheus-en",
    moderator: "aura-2-harmonia-en",
    dominator: "aura-2-saturn-en",
    data: "aura-2-electra-en",
    fence: "aura-2-hermes-en",
  },
  groq: {
    // Orpheus serves EXACTLY six voices — verified live against
    // /openai/v1/audio/speech, which rejects anything else with
    // "voice must be one of the following voices: [autumn diana hannah austin
    // daniel troy]". Six personas, six voices, one each: an earlier cast reused
    // hannah for hr/moderator/data and austin for technical/fence, which made
    // the GD moderator and the data debater literally the same speaker.
    hr: "hannah",
    technical: "austin",
    moderator: "diana",
    dominator: "troy",
    data: "autumn",
    fence: "daniel",
  },
  gemini: {
    hr: "Aoede",
    technical: "Charon",
    moderator: "Sulafat",
    dominator: "Orus",
    data: "Leda",
    fence: "Umbriel",
  },
  kokoro: {
    hr: "af_heart",
    technical: "am_michael",
    moderator: "bf_emma",
    dominator: "am_adam",
    data: "af_sarah",
    fence: "bm_george",
  },
};

/** Persona-appropriate delivery notes for engines that take style prompts
 * (OpenAI gpt-4o-mini-tts `instructions`). Short on purpose — they ride on
 * every request. */
export const VOICE_STYLE: Record<VoiceKey, string> = {
  hr: "A warm, attentive HR interviewer in a real conversation. Natural pace, friendly but professional, never sing-song.",
  technical: "A sharp, encouraging senior engineer running a technical interview. Calm, clear, conversational.",
  moderator: "A composed group-discussion moderator. Even, authoritative, keeps things moving.",
  dominator: "A confident, slightly impatient debater who speaks in absolutes. Assertive, quick.",
  data: "An analytical debater who quotes numbers. Precise, measured, a little brisk.",
  fence: "A thoughtful debater who sees both sides. Hedging, gentle, unhurried.",
};

/** Chatterbox wav filename (legacy contract) for a persona key. */
export function chatterboxVoiceFor(key: VoiceKey): string {
  if (key === "hr" || key === "technical") return INTERVIEWER_VOICES[key];
  return GD_PERSONA_VOICES[key] ?? INTERVIEWER_VOICES.hr;
}

const WAV_TO_KEY: Record<string, VoiceKey> = (() => {
  const m: Record<string, VoiceKey> = {};
  for (const [k, v] of Object.entries(INTERVIEWER_VOICES)) m[v.toLowerCase()] = k as VoiceKey;
  for (const [k, v] of Object.entries(GD_PERSONA_VOICES)) if (isVoiceKey(k)) m[v.toLowerCase()] = k;
  return m;
})();

/** Resolve whatever the client sent — a persona key, a legacy wav filename,
 * or nothing — to a persona key. Unknown values fall to the HR interviewer. */
export function voiceKeyOf(voice: string | undefined | null, fallback: VoiceKey = "hr"): VoiceKey {
  if (!voice) return fallback;
  if (isVoiceKey(voice)) return voice;
  return WAV_TO_KEY[voice.toLowerCase()] ?? fallback;
}

/** The engine-specific voice id for a persona key, honouring the per-engine
 * interviewer override env (ELEVENLABS_VOICE_ID, OPENAI_TTS_VOICE, …) for the
 * two 1:1 interviewer keys only — GD personas keep their distinct cast. */
export function castVoice(
  engine: CloudTtsEngine | "kokoro",
  key: VoiceKey,
  overrides: Partial<Record<CloudTtsEngine | "kokoro", string | undefined>> = {},
): string {
  const override = overrides[engine];
  if (override && (key === "hr" || key === "technical")) return override;
  return VOICE_CAST[engine][key];
}
