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

import { chatterboxDirectUrl, resolveVoiceEngine, setVoiceEnginePreference } from "@/lib/tts";

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

describe("the candidate's own studio voice server, from a deployed page", () => {
  // The app on Vercel can never reach a Chatterbox server — it lives on the
  // candidate's laptop. The BROWSER can: loopback is a trustworthy origin even
  // from an https page, and that server answers CORS for any origin. So when
  // the deployed server reports no studio voice, the page asks the machine it
  // is running on before settling for the on-device voice.
  function stubDeployedPage(local: "up" | "down" | "not-chatterbox", hostname = "placement-day-simulator.vercel.app") {
    vi.stubGlobal("window", { localStorage: storage, location: { hostname, protocol: "https:" } });
    const fetch = vi.fn(async (url: string) => {
      if (String(url).startsWith("http://127.0.0.1:8004/")) {
        if (local === "down") throw new TypeError("Failed to fetch");
        return { ok: true, json: async () => (local === "up" ? { voices: ["Emily.wav", "Michael.wav"] } : { hello: "world" }) };
      }
      return { ok: true, json: async () => ({ cloud: "groq", engines: ["groq"], chatterbox: false }) };
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("uses the local server when the deployed server has none but the browser's machine does", async () => {
    stubDeployedPage("up");
    await expect(resolveVoiceEngine()).resolves.toBe("chatterbox");
    expect(chatterboxDirectUrl()).toBe("http://127.0.0.1:8004");
  });

  it("stays on the on-device voice when nothing answers on the loopback port", async () => {
    stubDeployedPage("down");
    await expect(resolveVoiceEngine()).resolves.toBe("kokoro");
    expect(chatterboxDirectUrl()).toBeNull();
  });

  it("is not fooled by some other service on that port", async () => {
    stubDeployedPage("not-chatterbox");
    await expect(resolveVoiceEngine()).resolves.toBe("kokoro");
    expect(chatterboxDirectUrl()).toBeNull();
  });

  it("does not probe twice for a page served from that same machine — its own server already answered", async () => {
    const fetch = stubDeployedPage("up", "localhost");
    await expect(resolveVoiceEngine()).resolves.toBe("kokoro");
    expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual(["/api/tts"]);
    expect(chatterboxDirectUrl()).toBeNull();
  });

  it("the deployed server's own studio voice still wins, with no direct probe", async () => {
    vi.stubGlobal("window", { localStorage: storage, location: { hostname: "placement-day-simulator.vercel.app", protocol: "https:" } });
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ cloud: "groq", engines: ["groq"], chatterbox: true }) }));
    vi.stubGlobal("fetch", fetch);
    await expect(resolveVoiceEngine()).resolves.toBe("chatterbox");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(chatterboxDirectUrl()).toBeNull();
  });
});
