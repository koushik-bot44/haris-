import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Which voice engine a session settles on. This is the decision that keeps the
// interviewer sounding like ONE person for a whole interview, so the ordering
// is pinned here rather than left to whoever edits resolveVoiceEngine next.

vi.mock("@/lib/audio-viz", () => ({
  setAiHue: vi.fn(),
  startPseudoTalking: vi.fn(),
  stopPseudoTalking: vi.fn(),
  tapPlayback: vi.fn(),
}));
vi.mock("@/lib/tts-kokoro", () => ({
  ensureKokoroLoading: vi.fn(),
  kokoroReady: vi.fn(async () => true),
  kokoroSpeak: vi.fn(),
  kokoroStatus: vi.fn(() => "ready"),
  PRIYA_VOICE: "af_heart",
}));

import { resolveVoiceEngine, setVoiceEnginePreference } from "@/lib/tts";

/** Minimal localStorage — the real one does not exist under node. */
function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

/** What GET /api/tts reports. */
function stubCapabilities(caps: { cloud: string | null; engines?: string[]; chatterbox: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ cloud: caps.cloud, engines: caps.engines ?? [], chatterbox: caps.chatterbox }),
    })),
  );
}

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  storage = makeStorage();
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveVoiceEngine — one engine per session", () => {
  it("prefers the local Chatterbox server over everything", async () => {
    // Unmetered, studio voices, and the only engine that performs [chuckle]
    // style tags — if it is running, it wins.
    stubCapabilities({ cloud: "groq", engines: ["groq"], chatterbox: true });
    await expect(resolveVoiceEngine()).resolves.toBe("chatterbox");
  });

  it("does NOT auto-select Groq: 100 requests/day cannot carry an interview", async () => {
    // The regression that mattered. Groq Orpheus is metered so tightly that a
    // session would run out mid-interview and every later line would be voiced
    // by something else. On-device Kokoro is unmetered, so it wins.
    stubCapabilities({ cloud: "groq", engines: ["groq"], chatterbox: false });
    await expect(resolveVoiceEngine()).resolves.toBe("kokoro");
  });

  it("does auto-select a cloud engine whose quota can survive a session", async () => {
    stubCapabilities({ cloud: "elevenlabs", engines: ["elevenlabs"], chatterbox: false });
    await expect(resolveVoiceEngine()).resolves.toBe("cloud");
  });

  it("falls to the on-device voice when the server has no voice at all", async () => {
    // This is production on Vercel with no keys set — and it still speaks.
    stubCapabilities({ cloud: null, engines: [], chatterbox: false });
    await expect(resolveVoiceEngine()).resolves.toBe("kokoro");
  });

  it("an explicit pick beats the automatic order", async () => {
    stubCapabilities({ cloud: "groq", engines: ["groq"], chatterbox: true });
    setVoiceEnginePreference("cloud"); // the user wants the cloud voice anyway
    await expect(resolveVoiceEngine()).resolves.toBe("cloud");
  });

  it("an explicit pick is ignored when that engine is not actually available", async () => {
    stubCapabilities({ cloud: null, engines: [], chatterbox: false });
    setVoiceEnginePreference("chatterbox"); // server is not running
    await expect(resolveVoiceEngine()).resolves.toBe("kokoro");
  });

  it("REGRESSION: the auto-resolved engine is not remembered as a user choice", async () => {
    // resolveVoiceEngine caches its own result. If that cache were read back as
    // "the user picked this", the FIRST automatic answer would become permanent:
    // one session with Chatterbox down would pin the app to Kokoro forever, even
    // after Chatterbox came back.
    stubCapabilities({ cloud: null, engines: [], chatterbox: false });
    await expect(resolveVoiceEngine()).resolves.toBe("kokoro");

    stubCapabilities({ cloud: null, engines: [], chatterbox: true }); // it is back
    await expect(resolveVoiceEngine()).resolves.toBe("chatterbox");
  });

  it("a failed probe does not crash the interview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(resolveVoiceEngine()).resolves.toBeTypeOf("string");
  });
});
