import { describe, expect, it } from "vitest";
import { castVoice, chatterboxVoiceFor, CLOUD_TTS_ENGINES, isVoiceKey, VOICE_CAST, VOICE_KEYS, voiceKeyOf } from "@/lib/voice-cast";
import { GD_PERSONA_VOICES, INTERVIEWER_VOICES } from "@/lib/voices";

describe("voice cast (one persona → a distinct voice on every engine)", () => {
  it("every engine casts every persona", () => {
    for (const engine of [...CLOUD_TTS_ENGINES, "kokoro"] as const) {
      for (const key of VOICE_KEYS) {
        expect(typeof VOICE_CAST[engine][key]).toBe("string");
        expect(VOICE_CAST[engine][key].length).toBeGreaterThan(0);
      }
    }
  });

  it("the four GD participants never share a voice on engines with enough voices", () => {
    for (const engine of ["elevenlabs", "openai", "deepgram", "gemini", "kokoro"] as const) {
      const gd = ["moderator", "dominator", "data", "fence"].map((k) => VOICE_CAST[engine][k as "moderator"]);
      expect(new Set(gd).size).toBe(4);
    }
  });

  it("resolves legacy wav filenames to persona keys", () => {
    expect(voiceKeyOf(INTERVIEWER_VOICES.hr)).toBe("hr");
    expect(voiceKeyOf(INTERVIEWER_VOICES.technical)).toBe("technical");
    expect(voiceKeyOf(GD_PERSONA_VOICES.dominator)).toBe("dominator");
    expect(voiceKeyOf("emily.wav")).toBe("hr"); // case-insensitive
    expect(voiceKeyOf("moderator")).toBe("moderator");
    expect(voiceKeyOf(undefined)).toBe("hr");
    expect(voiceKeyOf("garbage")).toBe("hr");
    expect(voiceKeyOf("garbage", "technical")).toBe("technical");
  });

  it("chatterbox wav names round-trip through the key", () => {
    for (const key of VOICE_KEYS) {
      expect(voiceKeyOf(chatterboxVoiceFor(key))).toBe(key);
    }
  });

  it("interviewer overrides apply to the two 1:1 keys only", () => {
    expect(castVoice("openai", "hr", { openai: "nova" })).toBe("nova");
    expect(castVoice("openai", "technical", { openai: "nova" })).toBe("nova");
    expect(castVoice("openai", "dominator", { openai: "nova" })).toBe(VOICE_CAST.openai.dominator);
    expect(castVoice("openai", "hr", {})).toBe(VOICE_CAST.openai.hr);
  });

  it("isVoiceKey is strict", () => {
    expect(isVoiceKey("hr")).toBe(true);
    expect(isVoiceKey("HR")).toBe(false);
    expect(isVoiceKey("Emily.wav")).toBe(false);
  });
});
