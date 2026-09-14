import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkForOrpheus, cloudTtsEngines, defaultCloudTtsEngine } from "@/lib/tts-engines";
import { sttProvider, deepgramLiveEnabled } from "@/lib/stt-server";

const KEYS = [
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
  "DEEPGRAM_API_KEY",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "TTS_PROVIDER",
  "STT_PROVIDER",
  "DEEPGRAM_LIVE",
];

function env(vars: Record<string, string>) {
  for (const k of KEYS) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

describe("chunkForOrpheus (≤200-char requests)", () => {
  it("keeps short text as one chunk", () => {
    expect(chunkForOrpheus("Hello there. How are you?")).toEqual(["Hello there. How are you?"]);
  });

  it("packs sentences greedily under the limit", () => {
    const s1 = "This is the first sentence of the interviewer's reply, and it is fairly long.";
    const s2 = "This is the second sentence, which should not fit with the first one under the cap.";
    const s3 = "Third.";
    const chunks = chunkForOrpheus(`${s1} ${s2} ${s3}`, 120);
    expect(chunks).toEqual([s1, `${s2} ${s3}`]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120);
  });

  it("splits a single over-long sentence on clause boundaries", () => {
    const long = Array.from({ length: 12 }, (_, i) => `clause number ${i} goes here`).join(", ");
    const chunks = chunkForOrpheus(long, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(80);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toContain("clause number 11 goes here");
  });

  it("returns nothing for empty text", () => {
    expect(chunkForOrpheus("   ")).toEqual([]);
  });
});

describe("cloud engine selection", () => {
  it("nothing configured → no cloud engine", () => {
    env({});
    expect(cloudTtsEngines()).toEqual([]);
    expect(defaultCloudTtsEngine()).toBeNull();
  });

  it("orders configured engines by quality, TTS_PROVIDER first when its key exists", () => {
    env({ GROQ_API_KEY: "g", OPENAI_API_KEY: "o" });
    expect(cloudTtsEngines()).toEqual(["openai", "groq"]);
    env({ GROQ_API_KEY: "g", OPENAI_API_KEY: "o", TTS_PROVIDER: "groq" });
    expect(cloudTtsEngines()).toEqual(["groq", "openai"]);
    env({ GROQ_API_KEY: "g", TTS_PROVIDER: "elevenlabs" }); // preference without key is ignored
    expect(cloudTtsEngines()).toEqual(["groq"]);
  });

  it("a single Groq key unlocks LLM-adjacent voice AND transcription", () => {
    env({ GROQ_API_KEY: "g" });
    expect(defaultCloudTtsEngine()).toBe("groq");
    expect(sttProvider()).toBe("groq");
    expect(deepgramLiveEnabled()).toBe(false);
  });

  it("Deepgram live can be switched off while keeping batch transcription", () => {
    env({ DEEPGRAM_API_KEY: "d" });
    expect(deepgramLiveEnabled()).toBe(true);
    expect(sttProvider()).toBe("deepgram");
    env({ DEEPGRAM_API_KEY: "d", DEEPGRAM_LIVE: "0" });
    expect(deepgramLiveEnabled()).toBe(false);
  });
});
