// Chatterbox-Turbo paralinguistic tags. The interviewer prompt allows at most
// one per turn; TTS receives the raw text WITH tags, while captions and stored
// transcripts strip them via stripSpeechTags (the UI/transcript layer calls it).

export const TURBO_TAGS: readonly string[] = ["[chuckle]", "[sigh]", "[clear throat]", "[gasp]"];

// Only the known tags — unknown bracketed text (e.g. "[laughs]") is preserved.
const TAG_RE = new RegExp(
  TURBO_TAGS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "gi",
);

/** Remove known speech tags (case-insensitive), collapse doubled spaces, trim.
 * Idempotent — safe to call on already-stripped text. */
export function stripSpeechTags(text: string): string {
  return text
    .replace(TAG_RE, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

// ——— transcript/history text hygiene (pure, hook-facing) ———

/** Mirrors interviewRequestSchema's per-entry text cap. */
export const HISTORY_ENTRY_MAX_CHARS = 6000;
const TRUNCATION_MARKER = "…[truncated]";

/** Tail-truncate to the /api/interview per-entry cap so one giant pasted
 * answer can never make every later interview call fail validation. The full
 * text still lives in turnsRef/answersRef — only the LLM history is clamped. */
export function clampHistoryText(text: string, max: number = HISTORY_ENTRY_MAX_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** Keep the newest `max` characters (scoring sends the freshest content when a
 * combined answer outgrows the /api/score cap; the stored transcript stays full). */
export function keepTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}

/** Lowercased letters+digits only — "Mm-hm — go on?" and "mm hm go on" agree. */
function normChars(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Strip exact/near-exact occurrences of the interviewer's ack/nudge lines
 * from the EDGES of a candidate transcript — speaker audio the mic re-heard.
 * Edge-only on purpose: a legit "…decided to go on with…" mid-sentence stays. */
export function stripAckEcho(transcript: string, ackLines: readonly string[]): string {
  const targets = [...new Set(ackLines.map(normChars).filter(Boolean))];
  if (targets.length === 0) return transcript;
  let words = transcript.split(/\s+/).filter(Boolean);

  // Peel one matching ack line off the front/back; word-boundary prefixes are
  // compared by normalized characters so punctuation/spacing variants match.
  const peel = (fromEnd: boolean): boolean => {
    for (const t of targets) {
      let acc = "";
      for (let k = 1; k <= words.length; k++) {
        const w = normChars(words[fromEnd ? words.length - k : k - 1]);
        acc = fromEnd ? w + acc : acc + w;
        if (acc === t) {
          words = fromEnd ? words.slice(0, words.length - k) : words.slice(k);
          return true;
        }
        if (acc.length >= t.length) break;
      }
    }
    return false;
  };
  while (peel(false)) {}
  while (peel(true)) {}
  return words.join(" ");
}
