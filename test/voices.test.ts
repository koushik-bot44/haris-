import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GD_PERSONA_VOICES,
  getPreferredVoice,
  INTERVIEWER_VOICES,
  setPreferredVoice,
  voiceForRound,
  WAV_VOICE_RE,
} from "@/lib/voices";

describe("voice casting (pinned cross-agent contract)", () => {
  it("casts the two interviewers exactly as pinned", () => {
    expect(INTERVIEWER_VOICES).toEqual({ hr: "Elena.wav", technical: "Michael.wav" });
  });

  it("casts the four GD personas exactly as pinned", () => {
    expect(GD_PERSONA_VOICES).toEqual({
      moderator: "Olivia.wav",
      dominator: "Axel.wav",
      data: "Gianna.wav",
      fence: "Connor.wav",
    });
  });

  it("voiceForRound maps round type to the interviewer voice", () => {
    expect(voiceForRound("hr")).toBe("Elena.wav");
    expect(voiceForRound("technical")).toBe("Michael.wav");
  });

  describe("preferred voice (setup-screen picker contract)", () => {
    afterEach(() => vi.unstubAllGlobals());

    function stubStorage() {
      const store = new Map<string, string>();
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
          removeItem: (k: string) => void store.delete(k),
        },
      });
      return store;
    }

    it("SSR-safe: without window, reads null and writes are no-ops", () => {
      expect(getPreferredVoice()).toBeNull();
      expect(() => setPreferredVoice("Gianna.wav")).not.toThrow();
      expect(voiceForRound("hr")).toBe("Elena.wav");
      expect(voiceForRound("technical")).toBe("Michael.wav");
    });

    it("a preferred voice overrides the round default for BOTH rounds", () => {
      stubStorage();
      setPreferredVoice("Gianna.wav");
      expect(getPreferredVoice()).toBe("Gianna.wav");
      expect(voiceForRound("hr")).toBe("Gianna.wav");
      expect(voiceForRound("technical")).toBe("Gianna.wav");
    });

    it("null clears the preference back to the pinned defaults", () => {
      const store = stubStorage();
      setPreferredVoice("Connor.wav");
      setPreferredVoice(null);
      expect(getPreferredVoice()).toBeNull();
      expect(store.size).toBe(0);
      expect(voiceForRound("hr")).toBe("Elena.wav");
      expect(voiceForRound("technical")).toBe("Michael.wav");
    });

    it("uses the pinned localStorage key 'pds_voice_file'", () => {
      const store = stubStorage();
      setPreferredVoice("Elena.wav");
      expect(store.get("pds_voice_file")).toBe("Elena.wav");
    });

    it("a throwing localStorage (privacy mode) is survived", () => {
      const boom = () => {
        throw new Error("denied");
      };
      vi.stubGlobal("window", {
        localStorage: { getItem: boom, setItem: boom, removeItem: boom },
      });
      expect(getPreferredVoice()).toBeNull();
      expect(() => setPreferredVoice("Elena.wav")).not.toThrow();
      expect(() => setPreferredVoice(null)).not.toThrow();
      expect(voiceForRound("hr")).toBe("Elena.wav");
    });
  });

  it("every configured voice passes the /api/tts filename validation", () => {
    for (const v of [...Object.values(INTERVIEWER_VOICES), ...Object.values(GD_PERSONA_VOICES)]) {
      expect(v).toMatch(WAV_VOICE_RE);
    }
  });
});

describe("WAV_VOICE_RE (route hardening)", () => {
  it("accepts plain wav filenames", () => {
    for (const ok of ["Emily.wav", "My Voice_2.wav", "a-b.c.wav", `${"x".repeat(64)}.wav`]) {
      expect(ok).toMatch(WAV_VOICE_RE);
    }
  });

  it("rejects traversal, separators, and non-wav names", () => {
    for (const bad of [
      "../../etc/passwd.wav",
      "..%2Fetc.wav",
      "a/b.wav",
      "a\\b.wav",
      "voice.mp3",
      ".wav",
      "",
      "voice.wav\n",
      `${"x".repeat(65)}.wav`,
    ]) {
      expect(bad).not.toMatch(WAV_VOICE_RE);
    }
  });
});
