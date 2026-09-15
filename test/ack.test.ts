import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The ack module's contract, and the reason it was rewritten.
//
// Chrome caps how many AudioContexts a page may hold. This app had three —
// lib/tts.ts (where the interviewer's actual voice is scheduled),
// lib/tts-kokoro.ts (the on-device voice), and this module, purely to decode a
// one-second "mm-hm". The one that must never fail to get a context is the
// interviewer's. So the ack plays through an <audio> element off a blob URL and
// holds no context of its own — while keeping the property that made acks worth
// having: synthesized ONCE per (voice, kind), replayed from memory after that.

const env = vi.hoisted(() => ({ engine: "chatterbox" as string }));

vi.mock("@/lib/tts", () => ({
  getVoiceEngine: () => env.engine,
  isServerVoiceEngine: (e: string) => e === "cloud" || e === "chatterbox" || e === "elevenlabs",
  // The real one routes to /api/tts or the candidate's own Chatterbox server;
  // here it is the plain /api/tts request the assertions below inspect.
  fetchServerVoice: (engine: string, text: string, voice: string | undefined, stream: boolean) =>
    fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, engine, ...(voice ? { voice } : {}), stream }) }),
}));

import { ACK_TEXTS, playAck, prepareAcks, resetAcks } from "@/lib/ack";

let audioContexts = 0;
let fetches: string[] = [];
let minted: string[] = [];
let revoked: string[] = [];

class FakeAudio {
  static instances: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  duration = 1.2;
  paused = false;
  playCount = 0;
  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.playCount++;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

beforeEach(() => {
  audioContexts = 0;
  fetches = [];
  minted = [];
  revoked = [];
  FakeAudio.instances.length = 0;
  env.engine = "chatterbox";

  // Both spellings count: an implementation that reached for the prefixed
  // constructor would otherwise pass the "no AudioContext" assertion below
  // while still holding a context.
  class CountingContext {
    constructor() {
      audioContexts++;
    }
  }
  vi.stubGlobal("AudioContext", CountingContext);
  vi.stubGlobal("webkitAudioContext", CountingContext);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("fetch", async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { text?: string };
    fetches.push(body.text ?? "");
    return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }) };
  });

  const u = URL as unknown as {
    createObjectURL: (b: Blob) => string;
    revokeObjectURL: (s: string) => void;
  };
  u.createObjectURL = () => {
    const url = `blob:ack-${minted.length}`;
    minted.push(url);
    return url;
  };
  u.revokeObjectURL = (s: string) => {
    revoked.push(s);
  };

  resetAcks();
});

afterEach(() => {
  resetAcks();
  vi.unstubAllGlobals();
});

const ALL_LINES = Object.values(ACK_TEXTS).flat();

describe("prepareAcks", () => {
  it("synthesizes every line once through the server engine", async () => {
    await prepareAcks("moderator");
    expect(fetches).toEqual(ALL_LINES);
    expect(minted).toHaveLength(ALL_LINES.length);
  });

  it("NEVER constructs an AudioContext — the interviewer's voice owns the only one", async () => {
    // Sanity: the stubs are live and DO count, so a zero below is meaningful.
    const g = globalThis as unknown as { AudioContext: new () => unknown; webkitAudioContext: new () => unknown };
    new g.AudioContext();
    new g.webkitAudioContext();
    expect(audioContexts).toBe(2);
    audioContexts = 0;

    await prepareAcks("moderator");
    const h = playAck("ack", "moderator");
    expect(h).not.toBeNull();
    h?.cancel();
    expect(audioContexts).toBe(0);
  });

  it("does nothing for an engine with no server bytes (system / kokoro)", async () => {
    env.engine = "system";
    await prepareAcks("moderator");
    expect(fetches).toHaveLength(0);
    expect(playAck("ack", "moderator")).toBeNull();
  });

  it("re-preparing the same voice does not re-synthesize", async () => {
    await prepareAcks("moderator");
    const first = fetches.length;
    await prepareAcks("moderator");
    expect(fetches).toHaveLength(first);
  });

  it("keys the cache by voice so personas never borrow each other's mannerisms", async () => {
    await prepareAcks("moderator");
    await prepareAcks("dominator");
    expect(fetches).toHaveLength(ALL_LINES.length * 2);
    expect(playAck("ack", "moderator")?.text).toBeTypeOf("string");
    expect(playAck("ack", "dominator")?.text).toBeTypeOf("string");
  });
});

describe("playAck", () => {
  it("plays a prepared line from memory — no further synthesis, ever", async () => {
    await prepareAcks("moderator");
    const before = fetches.length;
    for (let i = 0; i < 5; i++) playAck("ack", "moderator")?.cancel();
    expect(fetches).toHaveLength(before);
    expect(FakeAudio.instances).toHaveLength(5);
    expect(FakeAudio.instances.every((a) => a.playCount === 1)).toBe(true);
  });

  it("rotates through the lines so the room does not repeat itself", async () => {
    await prepareAcks("moderator");
    const spoken = [0, 1, 2].map(() => {
      const h = playAck("ack", "moderator");
      h?.cancel();
      return h?.text;
    });
    expect(new Set(spoken).size).toBe(ACK_TEXTS.ack.length);
  });

  it("resolves done when the clip ends", async () => {
    await prepareAcks("moderator");
    const h = playAck("ack", "moderator");
    expect(h).not.toBeNull();
    FakeAudio.instances[0].onended?.();
    await expect(h!.done).resolves.toBeUndefined();
  });

  it("a clip that can never play resolves instead of hanging the room", async () => {
    await prepareAcks("moderator");
    const h = playAck("ack", "moderator");
    FakeAudio.instances[0].onerror?.();
    await expect(h!.done).resolves.toBeUndefined();
  });

  it("cancel() pauses AND resolves — a cancelled ack must not be waited on", async () => {
    await prepareAcks("moderator");
    const h = playAck("ack", "moderator");
    h!.cancel();
    expect(FakeAudio.instances[0].paused).toBe(true);
    await expect(h!.done).resolves.toBeUndefined();
  });

  it("returns null when nothing was prepared", () => {
    expect(playAck("ack", "moderator")).toBeNull();
  });
});

describe("resetAcks", () => {
  it("hands every blob back and forgets the cache", async () => {
    await prepareAcks("moderator");
    const made = [...minted];
    resetAcks();
    expect(revoked).toEqual(made);
    expect(playAck("ack", "moderator")).toBeNull();
  });
});
