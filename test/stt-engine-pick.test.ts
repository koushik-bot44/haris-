import { afterEach, describe, expect, it, vi } from "vitest";
import { deepgramLiveEnabled, sttProvider } from "@/lib/stt-server";

// Which engine actually transcribes an answer. The old order asked "does this
// browser have a recognizer?" first, which meant Chrome ALWAYS won and the Groq
// Whisper path never ran in production — the reason a stored transcript reads
// "Expo hi myself Kaushik I am building not Expo". The order is now by
// accuracy, and these tests pin it.
//
// The module caches the capability probe for the visit (deliberately — it is
// one GET per session), so each case gets a fresh module registry.

type Caps = { cloud: string | null; deepgramLive: boolean };

async function freshStt(caps: Caps, browserRecognizer: boolean) {
  vi.resetModules();
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => caps }) as unknown as Response);
  if (browserRecognizer) {
    vi.stubGlobal("window", { SpeechRecognition: class {}, localStorage: undefined });
  } else {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => caps }) as unknown as Response);
  }
  const mod = await import("@/lib/stt");
  await mod.resolveSttCapabilities();
  return mod;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickSttEngine (accuracy order, not availability order)", () => {
  it("prefers the server Whisper path over Chrome's recognizer", async () => {
    const stt = await freshStt({ cloud: "groq", deepgramLive: false }, true);
    expect(stt.sttSupported()).toBe(true); // Chrome IS available…
    expect(stt.pickSttEngine()).toBe("cloud"); // …and still loses
  });

  it("falls back to Chrome when the server has no transcription key", async () => {
    const stt = await freshStt({ cloud: null, deepgramLive: false }, true);
    expect(stt.pickSttEngine()).toBe("chrome");
  });

  it("falls back to the on-device model when neither exists", async () => {
    const stt = await freshStt({ cloud: null, deepgramLive: false }, false);
    expect(stt.pickSttEngine()).toBe("whisper");
  });

  it("live streaming still outranks everything when it is configured", async () => {
    const stt = await freshStt({ cloud: "deepgram", deepgramLive: true }, true);
    expect(stt.pickSttEngine()).toBe("deepgram");
  });

  it("an explicit choice always wins over the automatic order", async () => {
    const stt = await freshStt({ cloud: "groq", deepgramLive: false }, true);
    stt.setSttEngineEphemeral("chrome");
    expect(stt.pickSttEngine()).toBe("chrome");
    stt.setSttEngineEphemeral(null);
  });

  it("a failed probe leaves the browser engines in charge", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("window", { SpeechRecognition: class {}, localStorage: undefined });
    const stt = await import("@/lib/stt");
    await stt.resolveSttCapabilities();
    expect(stt.pickSttEngine()).toBe("chrome");
  });
});

describe("nextSttEngine (a degrade must never route back to what just broke)", () => {
  it("hands a cloud outage to Chrome, and a Chrome outage to the cloud", async () => {
    const stt = await freshStt({ cloud: "groq", deepgramLive: false }, true);
    expect(stt.nextSttEngine("cloud")).toBe("chrome");
    expect(stt.nextSttEngine("chrome")).toBe("cloud");
  });

  it("ends at the on-device model when nothing else is left", async () => {
    const stt = await freshStt({ cloud: null, deepgramLive: false }, false);
    expect(stt.nextSttEngine("whisper")).toBe(null);
    expect(stt.nextSttEngine("cloud")).toBe("whisper");
  });
});

describe("/api/stt availability with only GROQ_API_KEY set", () => {
  // The whole cloud-first order rests on the server actually reporting a
  // provider in THIS project's environment, where GROQ_API_KEY is the only
  // speech key that exists.
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("reports groq as the provider and no live streaming", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.STT_PROVIDER;
    process.env.GROQ_API_KEY = "gsk_test";
    expect(sttProvider()).toBe("groq"); // GET /api/stt → { cloud: "groq" }
    expect(deepgramLiveEnabled()).toBe(false);
  });

  it("reports nothing when no speech key is configured", () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    expect(sttProvider()).toBe(null); // → the client keeps Chrome / on-device
  });
});
