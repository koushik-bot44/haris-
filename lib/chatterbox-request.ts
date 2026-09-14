// One request shape for the Chatterbox-TTS-Server, shared by the /api/tts
// route (which proxies the server for a page served from the same machine)
// and the browser (which talks to the candidate's OWN server directly when
// the page comes from Vercel). Both paths must send identical knobs, or the
// same speaker renders differently depending on which one carried the line.
import { chatterboxVoiceFor, isVoiceKey, voiceKeyOf } from "@/lib/voice-cast";

/** Where the server listens by default (that project's config.yaml). */
export const CHATTERBOX_DEFAULT_URL = "http://127.0.0.1:8004";

export interface ChatterboxTuning {
  seed: number;
  temperature: number;
  exaggeration: number;
  cfg_weight: number;
  speed_factor: number;
}

/** Lower temperature than the server's default: this is an interviewer
 * reading a question, not an audiobook performance. Less sampling variance
 * means a steadier voice between the two draws of a turn, and it renders
 * faster. Turbo ignores exaggeration/cfg_weight; the 0.5B model uses them. */
export const CHATTERBOX_DEFAULT_TUNING = { temperature: 0.7, exaggeration: 0.5, cfg_weight: 0.5, speed_factor: 1.0 } as const;
export const CHATTERBOX_SEED_BASE = 8_675_309;
/** 50 is the server's documented minimum; the crossfade between chunks is
 * 20 ms, so small chunks cost nothing audible and ARE the time-to-first-audio. */
export const CHATTERBOX_DEFAULT_CHUNK = 50;

/** A STABLE, non-zero seed per persona.
 *
 * Chatterbox treats seed 0 as "pick a random one", so every request re-rolls
 * the sampling and successive utterances of the same voice file differ in
 * pace, energy and warmth — audible as the interviewer's character shifting
 * mid-answer. A fixed seed derived from the persona key makes each speaker
 * deterministic while keeping the personas distinct. `base` 0 restores the
 * server's random behaviour. */
export function chatterboxSeed(key: string, base = CHATTERBOX_SEED_BASE): number {
  if (base === 0) return 0;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  return (base + (h % 100_000)) >>> 0;
}

/** The wav file for what the client sent: a legacy filename is used as is; a
 * persona key resolves through the cast, with `override` (CHATTERBOX_VOICE)
 * replacing the two 1:1 interviewer personas only — the GD debaters keep
 * their distinct cast or the room loses track of who is speaking. */
export function chatterboxVoiceFile(voice: string | undefined | null, override?: string | null): string {
  const key = voiceKeyOf(voice);
  if (voice && !isVoiceKey(voice)) return voice;
  const o = override?.trim();
  return o && (key === "hr" || key === "technical") ? o : chatterboxVoiceFor(key);
}

/** The native /tts body. Streaming answers a chunked WAV (0xFFFFFFFF sizes)
 * flushed as each text chunk finishes; non-streamed, the SAME endpoint answers
 * a finite WAV that decodeAudioData accepts. (The OpenAI-compatible
 * /v1/audio/speech is deliberately not used: it takes only `speed` and `seed`
 * and fills the other knobs from the server's own config, so the two draws of
 * one turn were sampled at different temperatures.) */
export function chatterboxRequestBody(
  text: string,
  voiceFile: string,
  stream: boolean,
  tuning: ChatterboxTuning,
  chunkSize: number = CHATTERBOX_DEFAULT_CHUNK,
): Record<string, unknown> {
  const chunk_size = Math.max(50, Math.min(500, chunkSize));
  return stream
    ? { text, voice_mode: "predefined", predefined_voice_id: voiceFile, stream: true, split_text: true, chunk_size, ...tuning }
    : { text, voice_mode: "predefined", predefined_voice_id: voiceFile, output_format: "wav", stream: false, split_text: true, chunk_size, ...tuning };
}

/** Is this the reply of a Chatterbox-TTS-Server voices endpoint (and not
 * whatever else happens to listen on that port)? */
export function chatterboxVoicesOf(reply: unknown): string[] | null {
  const list = (reply as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(list)) return null;
  return list.filter((v): v is string => typeof v === "string");
}
