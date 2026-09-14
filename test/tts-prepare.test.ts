import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// prepareSpeak is browser code; in node we mock the visual/kokoro side modules
// and stub AudioContext + fetch. The wav helpers stay real (pure).
vi.mock("@/lib/audio-viz", () => ({
  setAiHue: vi.fn(),
  startPseudoTalking: vi.fn(),
  stopPseudoTalking: vi.fn(),
  tapPlayback: vi.fn(),
}));
vi.mock("@/lib/tts-kokoro", () => ({
  ensureKokoroLoading: vi.fn(),
  kokoroSpeak: vi.fn(),
  kokoroStatus: vi.fn(() => "loading"), // kokoro never ready → the floor is the system voice
  PRIYA_VOICE: "af_heart",
}));

import { prepareSpeak, resetVoiceSession } from "@/lib/tts";

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  start() {
    queueMicrotask(() => this.onended?.());
  }
  stop() {
    this.onended?.();
  }
}

class FakeAudioContext {
  /** lib/tts.ts caches ONE context for the module's lifetime (sharedCtx), so a
   * test that needs to change its behaviour must patch this instance — a
   * freshly stubbed class is never constructed again. */
  static last: FakeAudioContext | null = null;
  state = "running";
  currentTime = 0;
  constructor() {
    FakeAudioContext.last = this;
  }
  resume() {
    return Promise.resolve();
  }
  async decodeAudioData(_buf: ArrayBuffer): Promise<AudioBuffer> {
    return { duration: 0.5 } as unknown as AudioBuffer;
  }
  createBufferSource(): AudioBufferSourceNode {
    return new FakeSource() as unknown as AudioBufferSourceNode;
  }
}

function okResponse() {
  return { ok: true, body: undefined, arrayBuffer: async () => new ArrayBuffer(16) };
}

type FetchMock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
  // A failed server voice latches the WHOLE session to the on-device voice, so
  // one utterance can never be cloud while the next is Kokoro. That latch is
  // module state and outlives a single test the way it outlives a single turn;
  // each case here is a fresh interview, which is what clears it in the app
  // (resolveVoiceEngine at mic-check).
  resetVoiceSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prepareSpeak (ahead-of-time TTS)", () => {
  it("fetches buffered audio once and play() is instant on the real engine", async () => {
    const fetchMock: FetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const p = prepareSpeak("Hello there, welcome to the interview.", { voice: "Emily.wav" });
    await p.ready;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tts");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Hello there, welcome to the interview.",
      engine: "cloud", // no window → default engine (the server picks the voice), same as the live path
      voice: "Emily.wav",
      stream: false, // ahead-of-time: buffered on purpose, not streamed
    });

    const before = Date.now();
    const h = p.play();
    const t = await h.firstSyllableAt;
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
    await expect(h.engineUsed).resolves.toBe("cloud");
    await h.done;
    // No second fetch — playback used the pre-decoded buffer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("play() while still preparing WAITS for the buffer instead of synthesizing twice", async () => {
    let finish!: (r: ReturnType<typeof okResponse>) => void;
    const fetchMock: FetchMock = vi.fn(() => new Promise((r) => (finish = r)));
    vi.stubGlobal("fetch", fetchMock);

    const p = prepareSpeak("Question one is ready shortly.");
    const h = p.play(); // ready not resolved yet — must not abort the prepare
    setTimeout(() => finish(okResponse()), 30);
    await expect(h.engineUsed).resolves.toBe("cloud");
    await h.done;
    expect(fetchMock).toHaveBeenCalledTimes(1); // the prepared audio was used
  });

  it("play() gives up waiting on a stalled preparation and falls back to live speak()", async () => {
    const fetchMock: FetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {})) // prepare hangs forever
      .mockImplementation(async () => okResponse()); // live path succeeds
    vi.stubGlobal("fetch", fetchMock);

    const p = prepareSpeak("Question two.");
    const h = p.play();
    await expect(h.engineUsed).resolves.toBe("cloud");
    await h.done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const liveBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(liveBody.stream).toBe(true); // the live call is the normal streaming path
    p.cancel();
  }, 10_000);

  it("failed preparation is silent: ready resolves, play() walks down to the floor voice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("server down");
      }),
    );

    const p = prepareSpeak("Hi.");
    await expect(p.ready).resolves.toBeUndefined(); // never rejects
    const h = p.play();
    // Live cloud fails and Kokoro isn't ready → the FLOOR speaks (system
    // voice; unsupported in node, so it resolves immediately). The interviewer
    // is never silent, and engineUsed reports the truth.
    await expect(h.engineUsed).resolves.toBe("system");
    await h.done;
  });

  it("cancel() aborts the in-flight fetch", () => {
    let sawSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        sawSignal = init.signal ?? undefined;
        return new Promise(() => {});
      }),
    );

    const p = prepareSpeak("Never spoken.");
    expect(sawSignal?.aborted).toBe(false);
    p.cancel();
    expect(sawSignal?.aborted).toBe(true);
  });

  it("cancel() after ready frees the buffer — play() re-fetches live", async () => {
    const fetchMock: FetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const p = prepareSpeak("Freed.");
    await p.ready;
    p.cancel();
    const h = p.play(); // buffer gone → live fallback, not silence
    await expect(h.engineUsed).resolves.toBe("cloud");
    await h.done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("the buffer is consumed once: a second play() routes live", async () => {
    const fetchMock: FetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const p = prepareSpeak("Once only.");
    await p.ready;
    const h1 = p.play();
    await expect(h1.engineUsed).resolves.toBe("cloud");
    await h1.done;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const h2 = p.play(); // no double-scheduling of the same buffer
    await expect(h2.engineUsed).resolves.toBe("cloud");
    await h2.done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("play() cancel() during the ensureRunning() await stops the line before a source exists (GD barge-in)", async () => {
    // The GD room hands persona turns to prepared buffers and cancels the
    // returned handle on barge-in / SPACE. cancel() used to be a no-op while
    // playBuffer awaited the context resume — the line played on over the
    // candidate. Pin: a suspended context whose resume() takes a tick, cancel
    // before it lands, and no buffer source may ever be created or started.
    const fetchMock: FetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const p = prepareSpeak("The candidate interrupts this line.");
    await p.ready; // decodeAudioData ran → the shared context exists now
    const ctx = FakeAudioContext.last!;
    expect(ctx).toBeTruthy();
    let sources = 0;
    let starts = 0;
    const pendingResumes: Array<() => void> = [];
    const patched = ctx as unknown as {
      state: string;
      resume: () => Promise<void>;
      createBufferSource: () => AudioBufferSourceNode;
    };
    const original = { resume: patched.resume, createBufferSource: patched.createBufferSource };
    patched.state = "suspended";
    patched.resume = () => new Promise<void>((r) => pendingResumes.push(r));
    patched.createBufferSource = () => {
      sources++;
      const s = new FakeSource();
      const start = s.start.bind(s);
      s.start = () => {
        starts++;
        start();
      };
      return s as unknown as AudioBufferSourceNode;
    };
    try {
      const h = p.play(); // buffer ready → playBuffer, now parked in ensureRunning()
      expect(pendingResumes.length).toBeGreaterThan(0); // proves it IS parked there
      h.cancel(); // barge-in lands in that window
      patched.state = "running";
      for (const r of pendingResumes) r(); // the context unlocks afterwards — must NOT start the line
      await h.done;
      await expect(h.firstSyllableAt).resolves.toBeTypeOf("number"); // awaiters never hang
      expect(sources).toBe(0);
      expect(starts).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1); // and no live re-synthesis either
    } finally {
      patched.state = "running";
      patched.resume = original.resume;
      patched.createBufferSource = original.createBufferSource;
    }
  });

  it("play() cancel() while the preparation is still in flight never lets the line start", async () => {
    // The other GD path: SPACE lands while play() is waiting (bounded) on
    // ready. The wrapper must swallow the buffer when it arrives.
    let finish!: (r: ReturnType<typeof okResponse>) => void;
    const fetchMock: FetchMock = vi.fn(() => new Promise((r) => (finish = r)));
    vi.stubGlobal("fetch", fetchMock);
    const p = prepareSpeak("Still rendering when interrupted.");
    const h = p.play();
    h.cancel();
    // The shared context already exists from earlier cases; count sources on
    // the live instance, since a stubbed class would never be constructed.
    const ctx = FakeAudioContext.last as unknown as { createBufferSource: () => AudioBufferSourceNode } | null;
    let sources = 0;
    const originalCreate = ctx?.createBufferSource;
    if (ctx && originalCreate) {
      ctx.createBufferSource = () => {
        sources++;
        return originalCreate.call(ctx);
      };
    }
    try {
      finish(okResponse());
      await h.done;
      await expect(h.firstSyllableAt).resolves.toBeTypeOf("number");
      expect(sources).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (ctx && originalCreate) ctx.createBufferSource = originalCreate;
    }
  });

  it("a junk stored voice name is dropped rather than sent (a 400 would mean silence)", async () => {
    const fetchMock: FetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const p = prepareSpeak("Voice check.", { voice: "../../etc/passwd.wav" });
    await p.ready;
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.voice).toBeUndefined();
  });
});
