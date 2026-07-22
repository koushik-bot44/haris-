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
  kokoroStatus: vi.fn(() => "loading"), // kokoro never ready → chain floor is system
  PRIYA_VOICE: "af_priya",
}));

import { prepareSpeak } from "@/lib/tts";

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
  state = "running";
  currentTime = 0;
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prepareSpeak (ahead-of-time TTS)", () => {
  it("fetches buffered audio once and play() is instant on the real engine", async () => {
    const fetchMock: FetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const p = prepareSpeak("Hello there, welcome to the interview.", { voice: "Elena.wav" });
    await p.ready;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tts");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Hello there, welcome to the interview.",
      engine: "chatterbox", // no window → default engine, same as the live path
      voice: "Elena.wav",
      stream: false, // ahead-of-time: buffered on purpose, not streamed
    });

    const before = Date.now();
    const h = p.play();
    const t = await h.firstSyllableAt;
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
    await expect(h.engineUsed).resolves.toBe("chatterbox");
    await h.done;
    // No second fetch — playback used the pre-decoded buffer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("play() before ready transparently falls back to live speak()", async () => {
    const fetchMock: FetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {})) // prepare hangs forever
      .mockImplementation(async () => okResponse()); // live path succeeds
    vi.stubGlobal("fetch", fetchMock);

    const p = prepareSpeak("Question two.");
    const h = p.play(); // ready never resolved — must not block or throw
    await expect(h.engineUsed).resolves.toBe("chatterbox");
    await h.done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const liveBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(liveBody.stream).toBe(true); // the live call is the normal streaming path
    p.cancel();
  });

  it("failed preparation is silent: ready resolves, play() walks the engine chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("server down");
      }),
    );

    const p = prepareSpeak("Hi.");
    await expect(p.ready).resolves.toBeUndefined(); // never rejects
    const h = p.play();
    // Live chatterbox fails too → kokoro not ready → system floor.
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
    await expect(h.engineUsed).resolves.toBe("chatterbox");
    await h.done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("the buffer is consumed once: a second play() routes live", async () => {
    const fetchMock: FetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const p = prepareSpeak("Once only.");
    await p.ready;
    const h1 = p.play();
    await expect(h1.engineUsed).resolves.toBe("chatterbox");
    await h1.done;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const h2 = p.play(); // no double-scheduling of the same buffer
    await expect(h2.engineUsed).resolves.toBe("chatterbox");
    await h2.done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
