// Voice casting — pinned cross-agent contract. Filenames are predefined
// voices on the local Chatterbox server (GET /v1/audio/voices lists all 28).

/** Wav filename only — no path separators, so no traversal. Mirrored by the
 * /api/tts request schema. */
export const WAV_VOICE_RE = /^[A-Za-z0-9 ._-]{1,64}\.wav$/;

export const INTERVIEWER_VOICES: Record<"hr" | "technical", string> = {
  hr: "Emily.wav", // user-picked default interviewer voice
  technical: "Michael.wav",
};

export const GD_PERSONA_VOICES: Record<string, string> = {
  moderator: "Olivia.wav",
  dominator: "Axel.wav",
  data: "Gianna.wav", // Emily is the 1:1 interviewer — keep GD voices distinct
  fence: "Connor.wav",
};

// Preferred-voice plumbing — the setup-screen voice picker (app/page.tsx)
// writes THIS contract. SSR-safe like lib/tts.ts: window guarded, all
// localStorage access wrapped.
const PREFERRED_VOICE_KEY = "pds_voice_file";

/** The user's explicitly chosen interviewer voice file, or null when unset. */
export function getPreferredVoice(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PREFERRED_VOICE_KEY);
  } catch {
    return null;
  }
}

/** Persist the chosen voice; null clears the preference (back to defaults). */
export function setPreferredVoice(v: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (v === null) window.localStorage.removeItem(PREFERRED_VOICE_KEY);
    else window.localStorage.setItem(PREFERRED_VOICE_KEY, v);
  } catch {}
}

export function voiceForRound(roundType: "hr" | "technical"): string {
  return getPreferredVoice() ?? INTERVIEWER_VOICES[roundType];
}
