import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/tts/route";
import { chunkForOrpheus, cloudSpeak, TtsEngineError } from "@/lib/tts-engines";
import { CACHEABLE_TEXT_MAX, ttsCacheClear, ttsCacheStats } from "@/lib/tts-cache";
import { pcmToWav } from "@/lib/pcm-wav";
import { TURBO_TAGS } from "@/lib/speakable";

// /api/tts is the only mouth this app has. Everything below drives the REAL
// route and the REAL engine layer with only global fetch replaced, because the
// bugs that matter here (a persona served another persona's cached audio, a
// clip silently dropped out of the middle of a sentence, a short line buffered
// instead of streamed) all live in the seams between route, engine and cache —
// not inside any one of them.

// ——— fetch recorder ———

type Call = { url: string; init: RequestInit; body: Record<string, unknown> | null };

let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response>;
let warn: ReturnType<typeof vi.spyOn>;

function serveWith(fn: (call: Call) => Response | Promise<Response>): void {
  respond = fn;
}

/** Every env var the route or the engine layer reads. Cleared before each test
 * so a developer's real shell keys can never make a test pass or fail. */
const ENV_KEYS = [
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
  "DEEPGRAM_API_KEY",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "TTS_PROVIDER",
  "OPENAI_BASE_URL",
  "OPENAI_TTS_MODEL",
  "OPENAI_TTS_VOICE",
  "ELEVENLABS_MODEL",
  "ELEVENLABS_VOICE_ID",
  "DEEPGRAM_TTS_VOICE",
  "GROQ_TTS_MODEL",
  "GROQ_TTS_VOICE",
  "GEMINI_TTS_MODEL",
  "GEMINI_TTS_VOICE",
  "CHATTERBOX_URL",
  "CHATTERBOX_VOICE",
  "CHATTERBOX_SEED",
  "CHATTERBOX_TEMPERATURE",
  "CHATTERBOX_EXAGGERATION",
  "CHATTERBOX_CFG_WEIGHT",
  "CHATTERBOX_SPEED",
  "CHATTERBOX_CHUNK_SIZE",
];

function setEnv(vars: Record<string, string> = {}): void {
  for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}

beforeEach(() => {
  calls = [];
  respond = () => new Response("no stub installed", { status: 500 });
  ttsCacheClear();
  setEnv();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
    // Behave like the real thing: an already-aborted signal rejects with the
    // abort reason instead of quietly performing the request.
    if (init.signal?.aborted) {
      const reason: unknown = init.signal.reason;
      throw reason instanceof Error ? reason : new DOMException("aborted", "AbortError");
    }
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as { url: string }).url);
    let body: Record<string, unknown> | null = null;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const call: Call = { url, init, body };
    calls.push(call);
    return await respond(call);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

// ——— fixtures ———

function bytes(n: number, fill: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(new ArrayBuffer(n));
  b.fill(fill);
  return b;
}

/** What ElevenLabs/OpenAI/Deepgram return: raw little-endian PCM16, no container. */
function pcmOk(n = 64, fill = 7): Response {
  return new Response(bytes(n, fill), { status: 200 });
}

/** What Groq/Orpheus returns per request: a finite WAV clip. */
function wavClip(
  opts: { sampleRate?: number; channels?: number; bits?: number; data?: number; fill?: number } = {},
): Uint8Array<ArrayBuffer> {
  const { sampleRate = 24_000, channels = 1, bits = 16, data = 20, fill = 1 } = opts;
  return pcmToWav(bytes(data, fill), { sampleRate, channels, bitsPerSample: bits });
}

function postReq(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

function u32(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, true);
}

async function collect(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

/** Read a stream to completion, keeping whatever arrived BEFORE it errored —
 * the only way to prove a bad clip was refused rather than skipped. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; error: unknown }> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let error: unknown = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parts.push(value);
    }
  } catch (e) {
    error = e;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return { bytes: out, error };
}

/** An upstream body the test opens and closes by hand. */
function controlled() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return { stream, push: (b: Uint8Array) => ctrl.enqueue(b), close: () => ctrl.close() };
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(t));
}

async function waitFor(cond: () => boolean, what: string, ms = 1000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function lastBody(): Record<string, unknown> {
  const c = calls[calls.length - 1];
  if (!c) throw new Error("no upstream request was made");
  return c.body ?? {};
}

const OPENAI_URL = "https://api.openai.com/v1/audio/speech";
const CHATTERBOX_DEFAULT = "http://127.0.0.1:8004";

describe("GET /api/tts — the capability report the client picks an engine from", () => {
  // The landing page calls this BEFORE the interview starts and never calls it
  // again; resolveVoiceEngine() pins one engine for the whole session from this
  // exact shape. A missing field or a leaked key here is a session-long defect.
  let clock = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 60_000; // past the 5s probe TTL, so every test re-probes
    vi.setSystemTime(clock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports nothing configured as an all-off report, never as an error", async () => {
    serveWith(() => {
      throw new Error("ECONNREFUSED");
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cloud: null,
      engines: [],
      chatterbox: false,
      voices: [],
      enabled: false,
      elevenlabs: false,
    });
  });

  it("must not be cached — a key added or a local server started must show up", async () => {
    serveWith(() => new Response(null, { status: 503 }));
    expect((await GET()).headers.get("cache-control")).toBe("no-store");
  });

  it("`cloud` is exactly engines[0], and the legacy flags mirror elevenlabs only", async () => {
    setEnv({ DEEPGRAM_API_KEY: "d", ELEVENLABS_API_KEY: "e" });
    serveWith(() => new Response(null, { status: 503 }));
    const body = (await (await GET()).json()) as { cloud: string; engines: string[]; enabled: boolean; elevenlabs: boolean };
    expect(body.engines).toEqual(["elevenlabs", "deepgram"]);
    expect(body.cloud).toBe(body.engines[0]);
    expect(body.enabled).toBe(true);
    expect(body.elevenlabs).toBe(true);
  });

  it("legacy flags stay false when elevenlabs is not the configured engine", async () => {
    setEnv({ DEEPGRAM_API_KEY: "d" });
    serveWith(() => new Response(null, { status: 503 }));
    const body = (await (await GET()).json()) as { cloud: string; enabled: boolean; elevenlabs: boolean };
    expect(body.cloud).toBe("deepgram");
    expect(body.enabled).toBe(false);
    expect(body.elevenlabs).toBe(false);
  });

  it("TTS_PROVIDER moves its engine to the front of the report", async () => {
    setEnv({ OPENAI_API_KEY: "o", GROQ_API_KEY: "g", TTS_PROVIDER: "groq" });
    serveWith(() => new Response(null, { status: 503 }));
    const body = (await (await GET()).json()) as { cloud: string; engines: string[] };
    expect(body.engines).toEqual(["groq", "openai"]);
    expect(body.cloud).toBe("groq");
  });

  it("a TTS_PROVIDER whose key is missing is ignored rather than reported", async () => {
    setEnv({ OPENAI_API_KEY: "o", TTS_PROVIDER: "elevenlabs" });
    serveWith(() => new Response(null, { status: 503 }));
    const body = (await (await GET()).json()) as { cloud: string; engines: string[] };
    expect(body.engines).toEqual(["openai"]);
    expect(body.cloud).toBe("openai");
  });

  it("never leaks a key value, only engine names", async () => {
    setEnv({
      OPENAI_API_KEY: "sk-openai-SECRET-1",
      ELEVENLABS_API_KEY: "el-SECRET-2",
      GEMINI_API_KEY: "gem-SECRET-3",
    });
    serveWith(() => new Response(null, { status: 503 }));
    const text = await (await GET()).text();
    for (const secret of ["SECRET-1", "SECRET-2", "SECRET-3"]) expect(text).not.toContain(secret);
    expect(text).toContain("elevenlabs");
  });

  it("reports the local Chatterbox server and its voice list when it answers", async () => {
    serveWith(() => Response.json({ voices: ["Emily.wav", "Michael.wav"] }));
    const body = (await (await GET()).json()) as { chatterbox: boolean; voices: string[] };
    expect(calls[0].url).toBe(`${CHATTERBOX_DEFAULT}/v1/audio/voices`);
    expect(body.chatterbox).toBe(true);
    expect(body.voices).toEqual(["Emily.wav", "Michael.wav"]);
  });

  it("drops non-string entries from the voice list instead of shipping them to the picker", async () => {
    serveWith(() => Response.json({ voices: ["Emily.wav", 42, null, { name: "x" }, "Michael.wav"] }));
    const body = (await (await GET()).json()) as { voices: string[] };
    expect(body.voices).toEqual(["Emily.wav", "Michael.wav"]);
  });

  it("survives a probe payload with no voices array at all", async () => {
    serveWith(() => Response.json({ ok: true }));
    const body = (await (await GET()).json()) as { chatterbox: boolean; voices: string[] };
    expect(body.chatterbox).toBe(true);
    expect(body.voices).toEqual([]);
  });

  it("counts a 200 with unparseable JSON as 'server is up, voices unknown'", async () => {
    serveWith(() => new Response("<html>not json</html>", { status: 200 }));
    const body = (await (await GET()).json()) as { chatterbox: boolean; voices: string[] };
    expect(body.chatterbox).toBe(true);
    expect(body.voices).toEqual([]);
  });

  it("a non-2xx probe means no local server", async () => {
    serveWith(() => new Response("nope", { status: 404 }));
    const body = (await (await GET()).json()) as { chatterbox: boolean; voices: string[] };
    expect(body.chatterbox).toBe(false);
    expect(body.voices).toEqual([]);
  });

  it("trims trailing slashes off CHATTERBOX_URL so the probe URL is never doubled", async () => {
    setEnv({ CHATTERBOX_URL: "http://voice.local:9000///" });
    serveWith(() => Response.json({ voices: [] }));
    await GET();
    expect(calls[0].url).toBe("http://voice.local:9000/v1/audio/voices");
  });

  it("never probes localhost in production — a deployed host has no local voice server", async () => {
    vi.stubEnv("NODE_ENV", "production");
    serveWith(() => Response.json({ voices: ["Emily.wav"] }));
    const body = (await (await GET()).json()) as { chatterbox: boolean };
    expect(calls).toHaveLength(0);
    expect(body.chatterbox).toBe(false);
  });

  it("probes at most once per 5s while the idle landing page polls", async () => {
    serveWith(() => Response.json({ voices: ["Emily.wav"] }));
    await GET();
    expect(calls).toHaveLength(1);

    vi.setSystemTime(clock + 4_000);
    const cached = (await (await GET()).json()) as { chatterbox: boolean };
    expect(calls).toHaveLength(1); // served from the probe cache
    expect(cached.chatterbox).toBe(true);

    vi.setSystemTime(clock + 6_000);
    await GET();
    expect(calls).toHaveLength(2); // TTL expired → probed again
  });

  it("re-reads the key set on every call even while the probe is cached", async () => {
    // The probe cache must not freeze the cloud half of the report: a key added
    // to the environment has to show up on the very next poll.
    serveWith(() => Response.json({ voices: [] }));
    const before = (await (await GET()).json()) as { cloud: string | null };
    expect(before.cloud).toBeNull();
    setEnv({ GROQ_API_KEY: "g" });
    const after = (await (await GET()).json()) as { cloud: string | null };
    expect(calls).toHaveLength(1); // probe still cached
    expect(after.cloud).toBe("groq");
  });
});

describe("POST /api/tts — request validation", () => {
  // The body is attacker-reachable: the voice name is interpolated into a
  // filename on the local Chatterbox server, and the text is billed per
  // character upstream. Everything below is refused BEFORE any network call.

  it("refuses a body that is not JSON at all", async () => {
    const res = await POST(postReq("this is not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["missing text", {}],
    ["empty text", { text: "" }],
    ["text as a number", { text: 42 }],
    ["text as null", { text: null }],
    ["text as an array of strings", { text: ["hello"] }],
    ["text one char over the 2000 cap", { text: "a".repeat(2001) }],
    ["a bare array body", []],
    ["a bare string body", '"just a string"'],
    ["a bare number body", 7],
    ["a null body", null],
    ["unknown engine", { text: "hi", engine: "kokoro" }],
    ["empty engine", { text: "hi", engine: "" }],
    ["engine as a number", { text: "hi", engine: 3 }],
    ["engine as an array", { text: "hi", engine: ["cloud"] }],
    ["stream as a string", { text: "hi", stream: "true" }],
    ["stream as a number", { text: "hi", stream: 1 }],
    ["voice as null", { text: "hi", voice: null }],
    ["voice as a number", { text: "hi", voice: 12 }],
  ])("refuses %s with 400 and no upstream call", async (_label, body) => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const res = await POST(postReq(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid shape" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["parent-directory traversal", "../../etc/passwd.wav"],
    ["windows traversal", "..\\..\\windows\\system32.wav"],
    ["a bare dot-dot", ".."],
    ["dots hidden inside a legal-looking name", "a..b.wav"],
    ["a name that is only dots", "....wav"],
    ["a subdirectory", "voices/Emily.wav"],
    ["an absolute windows path", "C:\\voices\\Emily.wav"],
    ["a URL", "http://evil.example/x.wav"],
    ["percent-encoded traversal", "%2e%2e%2fEmily.wav"],
    ["a NUL byte", "Emily.wav\u0000"],
    ["a newline", "Emily.wav\n"],
    ["a trailing space after the extension", "Emily.wav "],
    ["an uppercase extension", "Emily.WAV"],
    ["no extension", "Emily"],
    ["an empty voice", ""],
    ["an uppercased persona key", "HR"],
    ["a non-ascii filename", "Émily.wav"],
    ["a name past the 64-char cap", `${"a".repeat(61)}.wav`],
    ["a shell-injection-looking name", "Emily.wav; rm -rf /"],
    ["a null-prototype-looking key", "__proto__"],
  ])("refuses the voice %s, so it can never reach the voices dir", async (_label, voice) => {
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT });
    serveWith(() => new Response(controlled().stream, { status: 200 }));
    const res = await POST(postReq({ text: "hi", voice, engine: "chatterbox" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid shape" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["the hr persona key", "hr"],
    ["the technical persona key", "technical"],
    ["the moderator persona key", "moderator"],
    ["the dominator persona key", "dominator"],
    ["the data persona key", "data"],
    ["the fence persona key", "fence"],
    ["a legacy wav filename", "Emily.wav"],
    ["a wav name with spaces, dashes and underscores", "my voice-1_2.wav"],
    ["a wav name exactly at the 64-char cap", `${"a".repeat(60)}.wav`],
  ])("accepts %s", async (_label, voice) => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "hi", voice }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("accepts text at exactly the 2000-char cap and forwards all of it", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const text = "a".repeat(2000);
    const res = await POST(postReq({ text }));
    expect(res.status).toBe(200);
    expect(lastBody().input).toBe(text);
  });

  it("accepts a single character — the shortest legal utterance", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    expect((await POST(postReq({ text: "?" }))).status).toBe(200);
  });

  it("accepts unicode and emoji without mangling them upstream", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const text = "நல்வரவு — tell me about 你好 👋 प्रोजेक्ट";
    await POST(postReq({ text }));
    expect(lastBody().input).toBe(text);
  });

  it("defaults engine to cloud and stream to true when neither is sent", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "a".repeat(200) })); // long → uncacheable → raw stream
    expect(res.headers.get("x-tts-engine")).toBe("openai");
    // A streaming WAV: unbounded RIFF/data sizes, exactly what the gapless
    // player expects when the body has not finished arriving.
    const wav = await collect(res);
    expect(u32(wav, 4)).toBe(0xffffffff);
    expect(u32(wav, 40)).toBe(0xffffffff);
  });

  it("ignores unknown extra fields rather than rejecting a slightly newer client", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "hi", speed: 2, nonsense: { deep: true } }));
    expect(res.status).toBe(200);
  });

  it("accepts whitespace-only text (zod's min(1) counts spaces) and still answers audio", async () => {
    // Documents the real boundary: "   " is NOT rejected, so the engine layer
    // and the cache have to cope with it — see the empty-text Groq case below.
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "   " }));
    expect(res.status).toBe(200);
    expect(lastBody().input).toBe("   ");
  });
});

describe("POST /api/tts — engine selection and the TTS_PROVIDER preference", () => {
  // One key, one voice. Which engine a turn is spoken by has to be predictable,
  // because the interviewer changing voice mid-interview is the single most
  // obvious failure a listener notices.

  it("answers 404 no_cloud_tts (not 500) when the server has no voice at all", async () => {
    const res = await POST(postReq({ text: "hello" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "no_cloud_tts",
      message: "No cloud voice is configured on this server.",
    });
    expect(calls).toHaveLength(0);
  });

  it("answers 404 for an engine that is named explicitly but not configured", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    const res = await POST(postReq({ text: "hello", engine: "deepgram" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "tts_error",
      engine: "deepgram",
      message: "deepgram is not configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("engine:cloud picks the best-quality configured engine, not just any key", async () => {
    setEnv({ GROQ_API_KEY: "g", OPENAI_API_KEY: "o", DEEPGRAM_API_KEY: "d" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.headers.get("x-tts-engine")).toBe("openai");
    expect(calls[0].url).toBe(OPENAI_URL);
  });

  it("TTS_PROVIDER wins for engine:cloud when its key exists", async () => {
    setEnv({ GROQ_API_KEY: "g", OPENAI_API_KEY: "o", TTS_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "d" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.headers.get("x-tts-engine")).toBe("deepgram");
    expect(calls[0].url).toContain("api.deepgram.com");
  });

  it("a TTS_PROVIDER without its key falls back AND says so in the log", async () => {
    setEnv({ OPENAI_API_KEY: "o", TTS_PROVIDER: "elevenlabs" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.headers.get("x-tts-engine")).toBe("openai");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TTS_PROVIDER=elevenlabs"));
  });

  it("a TTS_PROVIDER naming an engine that does not exist is ignored silently", async () => {
    setEnv({ OPENAI_API_KEY: "o", TTS_PROVIDER: "kokoro-cloud" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.headers.get("x-tts-engine")).toBe("openai");
    expect(warn).not.toHaveBeenCalled();
  });

  it("an explicitly named engine beats TTS_PROVIDER", async () => {
    setEnv({ OPENAI_API_KEY: "o", DEEPGRAM_API_KEY: "d", TTS_PROVIDER: "openai" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "hello there", engine: "deepgram" }));
    expect(res.headers.get("x-tts-engine")).toBe("deepgram");
  });

  it("a whitespace-only key counts as unset, not as a configured engine", async () => {
    setEnv({ OPENAI_API_KEY: "   " });
    const res = await POST(postReq({ text: "hello" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("no_cloud_tts");
  });

  it("GEMINI_API_KEY and GOOGLE_API_KEY are interchangeable", async () => {
    setEnv({ GOOGLE_API_KEY: "g" });
    serveWith(() =>
      Response.json({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: "AAAA" } }] } }],
      }),
    );
    const res = await POST(postReq({ text: "hello there", stream: false }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-tts-engine")).toBe("gemini");
    expect(calls[0].init.headers).toMatchObject({ "x-goog-api-key": "g" });
  });

  it("what GET advertises as `cloud` is what POST engine:cloud actually uses", async () => {
    // The client asks GET once and then sends engine:"cloud" forever; if these
    // two ever disagree the reported engine name is a lie.
    setEnv({ GROQ_API_KEY: "g", DEEPGRAM_API_KEY: "d", TTS_PROVIDER: "groq" });
    serveWith((c) => (c.url.includes("audio/voices") ? new Response(null, { status: 503 }) : new Response(wavClip())));
    const advertised = (await (await GET()).json()) as { cloud: string };
    calls = [];
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.headers.get("x-tts-engine")).toBe(advertised.cloud);
  });

  it("the persona key drives the per-engine voice id", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    await POST(postReq({ text: "hello", voice: "dominator" }));
    expect(lastBody().voice).toBe("onyx");
    await POST(postReq({ text: "hello again", voice: "data" }));
    expect(lastBody().voice).toBe("shimmer");
  });

  it("an omitted voice falls back to the HR interviewer, never to a GD debater", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    await POST(postReq({ text: "hello" }));
    expect(lastBody().voice).toBe("marin");
  });

  it("the interviewer voice override applies to hr/technical but not to GD personas", async () => {
    setEnv({ OPENAI_API_KEY: "o", OPENAI_TTS_VOICE: "custom-voice" });
    serveWith(() => pcmOk());
    await POST(postReq({ text: "hello", voice: "hr" }));
    expect(lastBody().voice).toBe("custom-voice");
    await POST(postReq({ text: "hello", voice: "moderator" }));
    expect(lastBody().voice).toBe("sage");
  });
});

describe("POST /api/tts — the short-line cache", () => {
  // Acks and nudges repeat every session. Caching them keeps the per-minute
  // budget for real turns, but the key has to be exact: one persona served
  // another persona's audio would put the wrong voice in the wrong mouth.

  const SHORT = "Mm, okay.";

  it("keys on the TEXT: a different line is a miss, not the previous line's audio", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk(32, 1));
    const first = await POST(postReq({ text: SHORT, stream: false }));
    expect(first.headers.get("x-tts-cache")).toBe("miss");
    serveWith(() => pcmOk(32, 2));
    const second = await POST(postReq({ text: "Go on?", stream: false }));
    expect(second.headers.get("x-tts-cache")).toBe("miss");
    expect((await collect(second))[44]).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("keys on the VOICE: the technical interviewer never gets HR's audio", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk(32, 11));
    await POST(postReq({ text: SHORT, voice: "hr", stream: false }));
    serveWith(() => pcmOk(32, 22));
    const res = await POST(postReq({ text: SHORT, voice: "technical", stream: false }));
    expect(res.headers.get("x-tts-cache")).toBe("miss");
    expect((await collect(res))[44]).toBe(22);
    expect(calls).toHaveLength(2);
  });

  it.each(["moderator", "dominator", "data", "fence"])(
    "keys on the VOICE for the GD persona %s too — four debaters, four cache slots",
    async (voice) => {
      setEnv({ OPENAI_API_KEY: "o" });
      serveWith(() => pcmOk(32, 1));
      await POST(postReq({ text: SHORT, voice: "hr", stream: false }));
      serveWith(() => pcmOk(32, 9));
      const res = await POST(postReq({ text: SHORT, voice, stream: false }));
      expect(res.headers.get("x-tts-cache")).toBe("miss");
      expect((await collect(res))[44]).toBe(9);
    },
  );

  it("keys on the ENGINE: switching engines re-synthesizes instead of replaying", async () => {
    setEnv({ OPENAI_API_KEY: "o", DEEPGRAM_API_KEY: "d" });
    serveWith(() => pcmOk(32, 5));
    await POST(postReq({ text: SHORT, engine: "openai", stream: false }));
    serveWith(() => pcmOk(32, 6));
    const res = await POST(postReq({ text: SHORT, engine: "deepgram", stream: false }));
    expect(res.headers.get("x-tts-cache")).toBe("miss");
    expect(res.headers.get("x-tts-engine")).toBe("deepgram");
    expect((await collect(res))[44]).toBe(6);
  });

  it("a legacy wav filename and its persona key share one cache slot", async () => {
    // "Emily.wav" IS the hr persona — synthesizing it twice would waste budget.
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk(32, 4));
    await POST(postReq({ text: SHORT, voice: "hr", stream: false }));
    const res = await POST(postReq({ text: SHORT, voice: "Emily.wav", stream: false }));
    expect(res.headers.get("x-tts-cache")).toBe("hit");
    expect(calls).toHaveLength(1);
  });

  it("serves the second identical request from memory with no upstream call", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk(32, 3));
    const miss = await POST(postReq({ text: SHORT, stream: false }));
    const hit = await POST(postReq({ text: SHORT, stream: false }));
    expect(hit.headers.get("x-tts-cache")).toBe("hit");
    expect(hit.headers.get("x-tts-engine")).toBe("openai");
    expect(hit.headers.get("content-type")).toBe("audio/wav");
    expect(calls).toHaveLength(1);
    expect(Array.from(await collect(hit))).toEqual(Array.from(await collect(miss)));
  });

  it("normalises whitespace, so re-spacing a line is still a hit", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    await POST(postReq({ text: "Mm,  okay.\nGo on?", stream: false }));
    const res = await POST(postReq({ text: "  Mm, okay. Go on?  ", stream: false }));
    expect(res.headers.get("x-tts-cache")).toBe("hit");
    expect(calls).toHaveLength(1);
  });

  it("caches what was SPOKEN, so a tagged and an untagged line share one entry", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    await POST(postReq({ text: "[sigh] Take your time.", stream: false }));
    const res = await POST(postReq({ text: "Take your time.", stream: false }));
    expect(res.headers.get("x-tts-cache")).toBe("hit");
    expect(calls).toHaveLength(1);
  });

  it(`caches a line of exactly CACHEABLE_TEXT_MAX (${CACHEABLE_TEXT_MAX}) characters`, async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const text = "a".repeat(CACHEABLE_TEXT_MAX);
    await POST(postReq({ text, stream: false }));
    expect(ttsCacheStats().entries).toBe(1);
    expect((await POST(postReq({ text, stream: false }))).headers.get("x-tts-cache")).toBe("hit");
    expect(calls).toHaveLength(1);
  });

  it("does NOT cache one character past the boundary", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const text = "a".repeat(CACHEABLE_TEXT_MAX + 1);
    const first = await POST(postReq({ text, stream: false }));
    expect(first.headers.get("x-tts-cache")).toBe("miss");
    expect(ttsCacheStats().entries).toBe(0);
    const second = await POST(postReq({ text, stream: false }));
    expect(second.headers.get("x-tts-cache")).toBe("miss");
    expect(calls).toHaveLength(2);
  });

  it("measures the boundary against the SPOKEN text, after tags are stripped", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    // 168 raw chars, 160 once "[chuckle] " is gone → cacheable.
    const text = `[chuckle] ${"a".repeat(CACHEABLE_TEXT_MAX)}`;
    expect(text.length).toBeGreaterThan(CACHEABLE_TEXT_MAX);
    await POST(postReq({ text, stream: false }));
    expect(ttsCacheStats().entries).toBe(1);
  });

  it("the non-streaming path caches a FINITE wav, the only kind decodeAudioData accepts", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk(64, 8));
    await POST(postReq({ text: SHORT, stream: false }));
    const hit = await collect(await POST(postReq({ text: SHORT, stream: false })));
    expect(hit).toHaveLength(44 + 64);
    expect(u32(hit, 4)).toBe(36 + 64);
    expect(u32(hit, 40)).toBe(64);
  });

  it("a failed synthesis is never cached, so the next attempt really retries", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => new Response("upstream exploded", { status: 500 }));
    expect((await POST(postReq({ text: SHORT, stream: false }))).status).toBe(502);
    expect(ttsCacheStats().entries).toBe(0);
    serveWith(() => pcmOk());
    expect((await POST(postReq({ text: SHORT, stream: false }))).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("a cacheable STREAMED reply still streams — first bytes before upstream finishes", async () => {
    // The regression this protects: buffering the whole clip to fill the cache
    // delayed the first syllable of every SHORT line, i.e. the opening sentence
    // of every turn — exactly what the streaming path exists for.
    setEnv({ OPENAI_API_KEY: "o" });
    const upstream = controlled();
    serveWith(() => new Response(upstream.stream, { status: 200 }));
    const res = await POST(postReq({ text: SHORT }));
    expect(res.headers.get("x-tts-cache")).toBe("miss");

    upstream.push(bytes(16, 9));
    const reader = res.body!.getReader();
    const header = await within(reader.read(), 500, "the WAV header while upstream is still open");
    expect(header.value).toHaveLength(44); // streaming header, sent before any audio
    const audio = await within(reader.read(), 500, "the first audio chunk while upstream is still open");
    expect(audio.value).toHaveLength(16);

    upstream.close();
    const end = await within(reader.read(), 500, "the stream to close after upstream did");
    expect(end.done).toBe(true);
    await waitFor(() => ttsCacheStats().entries === 1, "the tee'd copy to reach the cache");
  });

  it("the tee'd copy lands in the cache as a finite wav and is served on the next ask", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk(48, 6));
    const streamed = await POST(postReq({ text: SHORT }));
    await drain(streamed.body!);
    await waitFor(() => ttsCacheStats().entries === 1, "the streamed copy to be cached");

    const hit = await POST(postReq({ text: SHORT }));
    expect(hit.headers.get("x-tts-cache")).toBe("hit");
    expect(calls).toHaveLength(1);
    const wav = await collect(hit);
    expect(u32(wav, 4)).toBe(36 + 48); // finite, not 0xFFFFFFFF
    expect(wav[44]).toBe(6);
  });

  it("an uncacheable streamed reply carries no cache header and stores nothing", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "a".repeat(CACHEABLE_TEXT_MAX + 1) }));
    expect(res.headers.get("x-tts-cache")).toBeNull();
    await drain(res.body!);
    await new Promise((r) => setTimeout(r, 20));
    expect(ttsCacheStats().entries).toBe(0);
  });

  it("a streamed miss the client abandons still fills the cache from the other tee branch", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk(32, 4));
    await POST(postReq({ text: SHORT })); // never read
    await waitFor(() => ttsCacheStats().entries === 1, "the abandoned stream to still be cached");
  });
});

describe("chunkForOrpheus — Orpheus' ~200-char request cap", () => {
  // Groq synthesizes a turn as a sequence of clips. If a chunk exceeds the cap
  // the request 400s and the whole turn is lost; if the split loses characters
  // the interviewer says something subtly different from the transcript.

  it("keeps a whole short turn as one request", () => {
    expect(chunkForOrpheus("Hello there. How are you?")).toEqual(["Hello there. How are you?"]);
  });

  it("packs a sentence that lands EXACTLY on the cap into one chunk", () => {
    const a = `${"a".repeat(94)}.`; // 95
    const b = `${"b".repeat(93)}.`; // 94 → 95 + 1 + 94 = 190
    expect(`${a} ${b}`).toHaveLength(190);
    expect(chunkForOrpheus(`${a} ${b}`)).toEqual([`${a} ${b}`]);
  });

  it("splits when the pair is one character over the cap", () => {
    const a = `${"a".repeat(95)}.`; // 96
    const b = `${"b".repeat(93)}.`; // 94 → 191
    expect(chunkForOrpheus(`${a} ${b}`)).toEqual([a, b]);
  });

  it("a single sentence of exactly 190 characters is left whole", () => {
    const s = `${"word ".repeat(40).slice(0, 189)}.`;
    expect(s).toHaveLength(190);
    expect(chunkForOrpheus(s)).toEqual([s]);
  });

  it("a single sentence one character over the cap is broken on a word boundary", () => {
    const s = `${"word ".repeat(40).slice(0, 189)}x.`;
    expect(s).toHaveLength(191);
    const chunks = chunkForOrpheus(s);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(190);
    expect(chunks[0].endsWith("word")).toBe(true); // cut at a space, no half word
  });

  it("prefers a clause boundary over a word boundary when one is near the cap", () => {
    const s = `${"x".repeat(150)}, ${"y".repeat(80)}.`;
    const [head] = chunkForOrpheus(s);
    expect(head).toBe("x".repeat(150));
  });

  it("hard-cuts a single word longer than the cap rather than looping forever", () => {
    const chunks = chunkForOrpheus("z".repeat(500));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(190);
    expect(chunks.join("")).toBe("z".repeat(500));
  });

  it.each([
    ["empty", ""],
    ["spaces only", "     "],
    ["tabs and newlines only", "\t\n  \n"],
  ])("returns no chunks for %s text", (_label, text) => {
    expect(chunkForOrpheus(text)).toEqual([]);
  });

  it("collapses newlines and runs of spaces before measuring", () => {
    expect(chunkForOrpheus("Tell me\n\nabout   your\tproject.")).toEqual(["Tell me about your project."]);
  });

  it("keeps a sentence containing abbreviations whole while it fits", () => {
    // The sentence splitter breaks after "Dr." and "Inc." — greedy packing has
    // to put them back together or the voice pauses mid-name.
    const s = "Dr. Rao works at Acme Inc. and leads the team.";
    expect(chunkForOrpheus(s)).toEqual([s]);
  });

  it.each([
    ["abbreviations", "Dr. Rao works at Acme Inc. in St. Louis, e.g. as a lead."],
    ["decimals", "Revenue grew 12.5 percent to 3.4 million in Q3."],
    ["ellipses", "Well... I suppose... it depends. Right?"],
    ["quotes and brackets", 'She said "no" (twice), then left. Then came back!'],
    ["unicode", "நல்வரவு. 你好世界。 Здравствуйте! Bonjour ?"],
    ["emoji", "Great work 👏👏 on the deploy. Ship it 🚀!"],
    ["no terminal punctuation", "one two three four five six seven eight nine ten"],
    ["only punctuation", "!!! ??? ..."],
  ])("loses no characters when splitting %s", (_label, text) => {
    for (const max of [190, 40, 12]) {
      const joined = chunkForOrpheus(text, max)
        .join("")
        .replace(/\s+/gu, "");
      expect(joined).toBe(text.replace(/\s+/gu, ""));
    }
  });

  it.each([190, 60, 25, 10])("never emits a chunk longer than max=%i", (max) => {
    const text = `${"alpha beta gamma delta ".repeat(20)}. ${"z".repeat(300)}. Short one.`;
    for (const c of chunkForOrpheus(text, max)) expect(c.length).toBeLessThanOrEqual(max);
  });

  it("emits no empty or untrimmed chunks", () => {
    const text = "  One.   Two!    Three?   ";
    for (const c of chunkForOrpheus(text, 8)) {
      expect(c).not.toBe("");
      expect(c).toBe(c.trim());
    }
  });

  it("keeps the turn in order when an over-long sentence follows a short one", () => {
    const chunks = chunkForOrpheus(`Short intro. ${"long ".repeat(60).trim()}.`, 60);
    expect(chunks[0]).toBe("Short intro.");
    expect(chunks.length).toBeGreaterThan(2);
  });

  it.each(["!", "?", "."])("splits on the sentence terminator '%s'", (mark) => {
    const a = `${"a".repeat(120)}${mark}`;
    const b = `${"b".repeat(120)}${mark}`;
    expect(chunkForOrpheus(`${a} ${b}`)).toEqual([a, b]);
  });
});

describe("Groq clip stitching — a bad clip fails the turn instead of vanishing", () => {
  // A mismatched or malformed clip used to be SKIPPED, which deleted a chunk of
  // the interviewer's sentence with nothing anywhere saying so. Failing lets the
  // caller re-speak the WHOLE turn through the fallback voice.

  const SENT_A = `${"A".repeat(100)}.`;
  const SENT_B = `${"B".repeat(100)}.`;
  const TWO_CHUNKS = `${SENT_A} ${SENT_B}`;

  /** Serve clip 1 for the "A" sentence and `second` for the "B" sentence. */
  function serveClips(second: Uint8Array<ArrayBuffer> | Response, first = wavClip({ fill: 1 })): void {
    serveWith((c) => {
      const input = String(c.body?.input ?? "");
      if (input.startsWith("A")) return new Response(first, { status: 200 });
      return second instanceof Response ? second : new Response(second, { status: 200 });
    });
  }

  beforeEach(() => {
    setEnv({ GROQ_API_KEY: "g" });
  });

  it("splits a long turn into one request per chunk and stitches one WAV out of them", async () => {
    serveClips(wavClip({ fill: 2 }));
    const audio = await cloudSpeak("groq", TWO_CHUNKS, "hr");
    const { bytes: out, error } = await drain(audio.body);
    expect(error).toBeNull();
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(44 + 20 + 20);
    expect(u32(out, 4)).toBe(0xffffffff); // ONE streaming header for the whole turn
    expect(u32(out, 24)).toBe(24_000);
    expect(out[44]).toBe(1);
    expect(out[64]).toBe(2); // the second clip's audio, right after the first's
  });

  it("fetches the next clip while the current one is still being consumed", async () => {
    serveClips(wavClip({ fill: 2 }));
    const audio = await cloudSpeak("groq", TWO_CHUNKS, "hr");
    const reader = audio.body.getReader();
    await reader.read();
    expect(calls).toHaveLength(2); // clip 2 is already in flight
    await reader.cancel();
  });

  it("throws when a later clip changes sample rate, naming both rates", async () => {
    serveClips(wavClip({ sampleRate: 48_000, fill: 2 }));
    const audio = await cloudSpeak("groq", TWO_CHUNKS, "hr");
    const { bytes: out, error } = await drain(audio.body);
    expect(error).toBeInstanceOf(TtsEngineError);
    expect((error as TtsEngineError).engine).toBe("groq");
    expect((error as Error).message).toBe("groq changed sample rate mid-utterance (24000 → 48000)");
    // The mismatched audio was NOT emitted under the first clip's header.
    expect(out).toHaveLength(44 + 20);
  });

  it.each([
    ["stereo", wavClip({ channels: 2, fill: 2 })],
    ["8-bit", wavClip({ bits: 8, fill: 2 })],
    ["truncated below a parsable header", bytes(8, 2)],
  ])("throws on a %s clip rather than dropping it", async (_label, clip) => {
    serveClips(clip);
    const audio = await cloudSpeak("groq", TWO_CHUNKS, "hr");
    const { bytes: out, error } = await drain(audio.body);
    expect(error).toBeInstanceOf(TtsEngineError);
    expect((error as Error).message).toBe("groq returned a clip in an unexpected format");
    expect(out).toHaveLength(44 + 20);
  });

  it("surfaces a clip that is not RIFF at all as a stream error, never as silence", async () => {
    // parseWavHeader throws "not_wav" before the format check can run — a
    // different error class, but the protection that matters (fail, do not
    // silently drop the chunk) still holds.
    serveClips(new Uint8Array(new TextEncoder().encode("ID3\u0004junk-mp3-bytes")));
    const audio = await cloudSpeak("groq", TWO_CHUNKS, "hr");
    const { bytes: out, error } = await drain(audio.body);
    expect((error as Error).message).toBe("not_wav");
    expect(out).toHaveLength(44 + 20);
  });

  it("a mid-turn HTTP failure surfaces on the stream instead of shortening the turn", async () => {
    serveClips(new Response("rate limited later", { status: 500 }));
    const audio = await cloudSpeak("groq", TWO_CHUNKS, "hr");
    const { bytes: out, error } = await drain(audio.body);
    expect(error).toBeInstanceOf(TtsEngineError);
    expect((error as Error).message).toContain("groq responded 500");
    expect(out).toHaveLength(44 + 20);
  });

  it("validates the FIRST clip eagerly, so a bad key is an HTTP error not a broken stream", async () => {
    serveWith(() => new Response("invalid api key", { status: 401 }));
    await expect(cloudSpeak("groq", TWO_CHUNKS, "hr")).rejects.toThrow(TtsEngineError);
    expect(calls).toHaveLength(1); // it gave up before requesting clip 2
  });

  it.each([
    ["stereo", wavClip({ channels: 2 })],
    ["8-bit", wavClip({ bits: 8 })],
    ["not a WAV", new Uint8Array(new TextEncoder().encode("ID3junk"))],
  ])("validates the FIRST clip's format eagerly (%s) — a proper 502, not a 200 with a dead body", async (_label, clip) => {
    // A broken body makes the client retry the whole utterance buffered: a
    // second /api/tts call and a second Orpheus request out of 100/day, for a
    // clip that could never have played.
    serveWith(() => new Response(clip, { status: 200 }));
    const res = await POST(postReq({ text: TWO_CHUNKS, engine: "groq" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "tts_error",
      engine: "groq",
      message: "groq returned a clip in an unexpected format",
    });
    expect(calls).toHaveLength(1); // clip 2 was never requested
  });

  it("through the route, a format change breaks the response body rather than serving a hole", async () => {
    serveClips(wavClip({ sampleRate: 16_000, fill: 2 }));
    const res = await POST(postReq({ text: TWO_CHUNKS, engine: "groq" }));
    expect(res.status).toBe(200); // headers were already on the wire
    const { bytes: out, error } = await drain(res.body!);
    expect(error).not.toBeNull();
    expect(out).toHaveLength(44 + 20);
  });

  it("issues exactly one request per chunk for a three-chunk turn", async () => {
    const text = `${SENT_A} ${SENT_B} ${"C".repeat(100)}.`;
    expect(chunkForOrpheus(text)).toHaveLength(3);
    serveWith(() => new Response(wavClip({ fill: 4 }), { status: 200 }));
    const audio = await cloudSpeak("groq", text, "hr");
    await drain(audio.body);
    expect(calls).toHaveLength(3);
  });

  it("answers 400 for text that chunks to nothing instead of calling Orpheus", async () => {
    const res = await POST(postReq({ text: "   ", engine: "groq" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "tts_error", engine: "groq", message: "empty text" });
    expect(calls).toHaveLength(0);
  });

  it("gives each GD persona its own Orpheus voice — six personas, six voices", async () => {
    serveWith(() => new Response(wavClip(), { status: 200 }));
    const voices: string[] = [];
    for (const voice of ["hr", "technical", "moderator", "dominator", "data", "fence"]) {
      // Distinct text per persona, so a cache hit can never hide a shared voice.
      const res = await POST(postReq({ text: `Hello, this is ${voice}.`, engine: "groq", voice, stream: false }));
      expect(res.status).toBe(200);
      voices.push(String(lastBody().voice));
    }
    expect(new Set(voices).size).toBe(6);
  });
});

describe("POST /api/tts — the local Chatterbox engine", () => {
  // Chatterbox is the studio voice: unmetered, clonable, and the only engine
  // that performs [chuckle]-style tags. Its knobs decide whether the same
  // persona sounds like the same person twice in a row.

  beforeEach(() => {
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT });
    serveWith(() => new Response(controlled().stream, { status: 200 }));
  });

  it("streams from the native /tts endpoint in predefined-voice mode", async () => {
    const res = await POST(postReq({ text: "Tell me about yourself.", engine: "chatterbox", voice: "hr" }));
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(`${CHATTERBOX_DEFAULT}/tts`);
    expect(lastBody()).toMatchObject({
      text: "Tell me about yourself.",
      voice_mode: "predefined",
      predefined_voice_id: "Emily.wav",
      stream: true,
      split_text: true,
    });
    expect(res.headers.get("x-tts-engine")).toBe("chatterbox");
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("uses the SAME native endpoint, un-streamed, when the caller does not want a stream", async () => {
    // It used to go through /v1/audio/speech, whose request model has no
    // temperature/exaggeration/cfg_weight — the server filled them from its own
    // config defaults. Draw 2 of every turn is prepared un-streamed, so the
    // opening sentence and the remainder were sampled with different knobs.
    serveWith(() => new Response(bytes(8, 1), { status: 200 }));
    const res = await POST(postReq({ text: "Tell me about yourself.", engine: "chatterbox", stream: false }));
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(`${CHATTERBOX_DEFAULT}/tts`);
    expect(lastBody()).toMatchObject({
      text: "Tell me about yourself.",
      voice_mode: "predefined",
      predefined_voice_id: "Emily.wav",
      output_format: "wav",
      stream: false,
    });
  });

  it("the two draws of a turn (streamed opening, buffered remainder) carry IDENTICAL generation knobs", async () => {
    serveWith(() => new Response(bytes(8, 1), { status: 200 }));
    await POST(postReq({ text: "Opening sentence.", engine: "chatterbox", voice: "technical", stream: true }));
    const draw1 = lastBody();
    await POST(postReq({ text: "The whole remainder.", engine: "chatterbox", voice: "technical", stream: false }));
    const draw2 = lastBody();
    for (const knob of ["seed", "temperature", "exaggeration", "cfg_weight", "speed_factor", "chunk_size", "predefined_voice_id"]) {
      expect(draw2[knob]).toBeDefined();
      expect(draw2[knob]).toEqual(draw1[knob]);
    }
  });

  it.each([
    ["hr", "Emily.wav"],
    ["technical", "Michael.wav"],
    ["moderator", "Olivia.wav"],
    ["dominator", "Axel.wav"],
    ["data", "Gianna.wav"],
    ["fence", "Connor.wav"],
  ])("maps the %s persona to its own voice file", async (voice, file) => {
    await POST(postReq({ text: "hello", engine: "chatterbox", voice }));
    expect(lastBody().predefined_voice_id).toBe(file);
  });

  it("passes an unknown-but-legal wav filename straight through as a cloned voice", async () => {
    await POST(postReq({ text: "hello", engine: "chatterbox", voice: "Candidate Clone-1.wav" }));
    expect(lastBody().predefined_voice_id).toBe("Candidate Clone-1.wav");
  });

  // CHATTERBOX_VOICE used to be dead configuration: the expression read
  // `chatterboxVoiceFor(key) || process.env.CHATTERBOX_VOICE`, and
  // chatterboxVoiceFor() always returns a filename, so the env branch could
  // never be reached — someone pointing it at their own cloned voice silently
  // got Emily.wav. It now overrides the two 1:1 interviewer personas, matching
  // castVoice()'s rule for the cloud engines.
  it.each([
    ["hr", "Someone.wav"],
    ["technical", "Someone.wav"],
  ])("CHATTERBOX_VOICE overrides the %s interviewer", async (voice, expected) => {
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT, CHATTERBOX_VOICE: "Someone.wav" });
    await POST(postReq({ text: "hello", engine: "chatterbox", voice }));
    expect(lastBody().predefined_voice_id).toBe(expected);
  });

  it("CHATTERBOX_VOICE applies with no voice at all (the default persona is hr)", async () => {
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT, CHATTERBOX_VOICE: "Someone.wav" });
    await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(lastBody().predefined_voice_id).toBe("Someone.wav");
  });

  it.each([
    ["moderator", "Olivia.wav"],
    ["dominator", "Axel.wav"],
    ["data", "Gianna.wav"],
    ["fence", "Connor.wav"],
  ])("CHATTERBOX_VOICE does NOT collapse the %s GD debater onto one voice", async (voice, file) => {
    // Four debaters sharing one voice file is the group-discussion equivalent of
    // the multi-voice bug — the room stops being able to tell who is speaking.
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT, CHATTERBOX_VOICE: "Someone.wav" });
    await POST(postReq({ text: "hello", engine: "chatterbox", voice }));
    expect(lastBody().predefined_voice_id).toBe(file);
  });

  it("a blank CHATTERBOX_VOICE falls back to the persona map", async () => {
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT, CHATTERBOX_VOICE: "   " });
    await POST(postReq({ text: "hello", engine: "chatterbox", voice: "hr" }));
    expect(lastBody().predefined_voice_id).toBe("Emily.wav");
  });

  it("gives a persona a STABLE non-zero seed across requests", async () => {
    // Seed 0 makes Chatterbox re-roll sampling every call, which is audible as
    // the interviewer's character shifting between the two draws of one turn.
    await POST(postReq({ text: "first line", engine: "chatterbox", voice: "hr" }));
    const first = lastBody().seed;
    await POST(postReq({ text: "a completely different line", engine: "chatterbox", voice: "hr" }));
    expect(lastBody().seed).toBe(first);
    expect(first).not.toBe(0);
    expect(typeof first).toBe("number");
  });

  it("derives a DIFFERENT seed for every persona so six speakers stay distinct", async () => {
    const seeds: unknown[] = [];
    for (const voice of ["hr", "technical", "moderator", "dominator", "data", "fence"]) {
      await POST(postReq({ text: "hello", engine: "chatterbox", voice }));
      seeds.push(lastBody().seed);
    }
    expect(new Set(seeds).size).toBe(6);
  });

  it("an unknown legacy voice file borrows the HR persona's seed, not a random one", async () => {
    await POST(postReq({ text: "hello", engine: "chatterbox", voice: "hr" }));
    const hrSeed = lastBody().seed;
    await POST(postReq({ text: "hello", engine: "chatterbox", voice: "Cloned.wav" }));
    expect(lastBody().seed).toBe(hrSeed);
  });

  it("CHATTERBOX_SEED=0 hands sampling randomness back to the server", async () => {
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT, CHATTERBOX_SEED: "0" });
    for (const voice of ["hr", "moderator", "fence"]) {
      await POST(postReq({ text: "hello", engine: "chatterbox", voice }));
      expect(lastBody().seed).toBe(0);
    }
  });

  it("CHATTERBOX_SEED shifts the whole cast but keeps them distinct and stable", async () => {
    await POST(postReq({ text: "hello", engine: "chatterbox", voice: "hr" }));
    const baseHr = lastBody().seed as number;
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT, CHATTERBOX_SEED: "12345" });
    const seeds: number[] = [];
    for (const voice of ["hr", "technical", "moderator"]) {
      await POST(postReq({ text: "hello", engine: "chatterbox", voice }));
      seeds.push(lastBody().seed as number);
    }
    expect(seeds[0]).not.toBe(baseHr);
    expect(seeds[0]).toBeGreaterThanOrEqual(12_345);
    expect(new Set(seeds).size).toBe(3);
  });

  it.each(["abc", "seed", "1,5", "1.2.3", "Infinity", "-Infinity", "true", "null"])(
    "ignores the unparseable CHATTERBOX_SEED %j and keeps the default cast",
    async (bad) => {
      await POST(postReq({ text: "hello", engine: "chatterbox", voice: "hr" }));
      const good = lastBody().seed;
      setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT, CHATTERBOX_SEED: bad });
      await POST(postReq({ text: "hello", engine: "chatterbox", voice: "hr" }));
      expect(lastBody().seed).toBe(good);
    },
  );

  it("sends the steadier interviewer defaults, not the server's audiobook ones", async () => {
    await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(lastBody()).toMatchObject({
      temperature: 0.7,
      exaggeration: 0.5,
      cfg_weight: 0.5,
      speed_factor: 1,
    });
  });

  it.each([
    ["CHATTERBOX_TEMPERATURE", "0.35", "temperature", 0.35],
    ["CHATTERBOX_EXAGGERATION", "0.9", "exaggeration", 0.9],
    ["CHATTERBOX_CFG_WEIGHT", "0.25", "cfg_weight", 0.25],
    ["CHATTERBOX_SPEED", "1.15", "speed_factor", 1.15],
  ])("honours %s", async (envName, value, field, expected) => {
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT, [envName]: value });
    await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(lastBody()[field]).toBe(expected);
  });

  it.each([
    ["CHATTERBOX_TEMPERATURE", "warm", "temperature", 0.7],
    ["CHATTERBOX_EXAGGERATION", "lots", "exaggeration", 0.5],
    ["CHATTERBOX_CFG_WEIGHT", "0.5.5", "cfg_weight", 0.5],
    ["CHATTERBOX_SPEED", "fast", "speed_factor", 1],
  ])("falls back to the default when %s is garbage", async (envName, value, field, expected) => {
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT, [envName]: value });
    await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(lastBody()[field]).toBe(expected);
  });

  it.each([
    ["unset", undefined, 50],
    ["below the documented minimum", "10", 50],
    ["zero", "0", 50],
    ["negative", "-500", 50],
    ["exactly the minimum", "50", 50],
    ["one below the minimum", "49", 50],
    ["in range", "200", 200],
    ["exactly the maximum", "500", 500],
    ["one over the maximum", "501", 500],
    ["far over the maximum", "100000", 500],
    ["garbage", "big", 50],
  ])("clamps chunk_size %s to 50–500 (%s → %i)", async (_label, value, expected) => {
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT, ...(value === undefined ? {} : { CHATTERBOX_CHUNK_SIZE: value }) });
    await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(lastBody().chunk_size).toBe(expected);
  });

  it("chunk_size IS the time-to-first-audio, so the default is the documented minimum", async () => {
    await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(lastBody().chunk_size).toBe(50);
  });

  it("trims trailing slashes off CHATTERBOX_URL", async () => {
    setEnv({ CHATTERBOX_URL: "http://voice.local:8004//" });
    await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(calls[0].url).toBe("http://voice.local:8004/tts");
  });

  it("answers 404 chatterbox_disabled in production with no CHATTERBOX_URL", async () => {
    setEnv();
    vi.stubEnv("NODE_ENV", "production");
    const res = await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "chatterbox_disabled" });
    expect(calls).toHaveLength(0);
  });

  it("never caches a Chatterbox line, however short", async () => {
    await POST(postReq({ text: "Mm, okay.", engine: "chatterbox" }));
    expect(ttsCacheStats().entries).toBe(0);
    const res = await POST(postReq({ text: "Mm, okay.", engine: "chatterbox" }));
    expect(res.headers.get("x-tts-cache")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("reports an upstream error as 502 with the upstream status attached", async () => {
    serveWith(() => new Response("model not loaded", { status: 503 }));
    const res = await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "chatterbox_error", status: 503 });
  });

  it("treats a 200 with no body as an error, not as silent audio", async () => {
    serveWith(() => new Response(null, { status: 200 }));
    const res = await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "chatterbox_error", status: 200 });
  });

  it("reports a server that is not running as chatterbox_unreachable", async () => {
    serveWith(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNREFUSED") });
    });
    const res = await POST(postReq({ text: "hello", engine: "chatterbox" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "chatterbox_unreachable" });
  });

  it("reports a client disconnect as chatterbox_timeout and stops synthesizing", async () => {
    const ctrl = new AbortController();
    const req = postReq({ text: "hello", engine: "chatterbox" }, ctrl.signal);
    ctrl.abort();
    const res = await POST(req);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "chatterbox_timeout" });
  });

  it("passes the caller's signal down so an abort really reaches the voice server", async () => {
    const ctrl = new AbortController();
    let seen: AbortSignal | null = null;
    serveWith((c) => {
      seen = c.init.signal ?? null;
      return new Response(controlled().stream, { status: 200 });
    });
    await POST(postReq({ text: "hello", engine: "chatterbox" }, ctrl.signal));
    expect(seen).not.toBeNull();
    expect(seen!.aborted).toBe(false);
    ctrl.abort();
    expect(seen!.aborted).toBe(true);
  });
});

describe("paralinguistic tags — performed locally, never read aloud in the cloud", () => {
  // "[chuckle]" is an instruction to Chatterbox-Turbo and a WORD to every cloud
  // voice. Sending it to the cloud makes the interviewer literally say
  // "chuckle" mid-sentence.

  it.each(TURBO_TAGS)("strips %s before a cloud request", async (tag) => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    await POST(postReq({ text: `${tag} Tell me about a time you failed.` }));
    expect(lastBody().input).toBe("Tell me about a time you failed.");
  });

  it("strips a tag written in any case", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    await POST(postReq({ text: "[CHUCKLE] Right, [Sigh] go on." }));
    expect(lastBody().input).toBe("Right, go on.");
  });

  it("keeps unknown bracketed text, because guessing at it is worse", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    await POST(postReq({ text: "[laughs] Tell me more." }));
    expect(lastBody().input).toBe("[laughs] Tell me more.");
  });

  it("never sends an EMPTY request when the line is nothing but a tag", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => pcmOk());
    const res = await POST(postReq({ text: "[sigh]" }));
    expect(res.status).toBe(200);
    expect(lastBody().input).toBe("[sigh]"); // raw text, rather than an empty synthesis
  });

  it("delivers the tag UNTOUCHED to Chatterbox, which performs it", async () => {
    setEnv({ CHATTERBOX_URL: CHATTERBOX_DEFAULT });
    serveWith(() => new Response(controlled().stream, { status: 200 }));
    await POST(postReq({ text: "[chuckle] Tell me about a time you failed.", engine: "chatterbox" }));
    expect(lastBody().text).toBe("[chuckle] Tell me about a time you failed.");
  });

  it("strips tags for Groq too, not just the streaming engines", async () => {
    setEnv({ GROQ_API_KEY: "g" });
    serveWith(() => new Response(wavClip(), { status: 200 }));
    await POST(postReq({ text: "[gasp] Really?", engine: "groq", stream: false }));
    expect(lastBody().input).toBe("Really?");
  });
});

describe("POST /api/tts — upstream failure, rate limits and cancellation", () => {
  // Everything here decides whether a sentence is delayed, re-voiced, or lost.
  // The client can only tell those apart from the status and the error body.

  it("turns an upstream 5xx into a 502 with the provider's own detail attached", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => new Response("model overloaded", { status: 503 }));
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "tts_error",
      engine: "openai",
      message: "openai responded 503: model overloaded",
    });
  });

  it("truncates a huge upstream error body instead of echoing it to the client", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => new Response("x".repeat(5000), { status: 500 }));
    const body = (await (await POST(postReq({ text: "hello there" }))).json()) as { message: string };
    expect(body.message.length).toBeLessThanOrEqual("openai responded 500: ".length + 400);
    expect(body.message.startsWith("openai responded 500: xxx")).toBe(true);
  });

  it("treats a 200 with no body as a failure rather than as zero audio", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => new Response(null, { status: 200 }));
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.status).toBe(502);
    expect((await res.json()).message).toBe("openai responded 200");
  });

  it("passes a rate limit through as 429 so the client can wait rather than re-voice", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.status).toBe(429);
    expect((await res.json()).engine).toBe("openai");
    // 30s is far past the backoff ceiling — waiting is worse than answering.
    expect(calls).toHaveLength(1);
  });

  it("waits the provider's own retry-after and retries once, keeping the studio voice", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    let n = 0;
    serveWith(() => (++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }) : pcmOk()));
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rate-limited"));
  });

  it("reads the delay out of the provider's message when there is no retry-after header", async () => {
    setEnv({ GROQ_API_KEY: "g" });
    let n = 0;
    serveWith(() =>
      ++n === 1
        ? new Response("Rate limit reached. Please try again in 12ms.", { status: 429 })
        : new Response(wavClip(), { status: 200 }),
    );
    const res = await POST(postReq({ text: "hello there", engine: "groq", stream: false }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("gives up after a bounded number of retries instead of hanging the turn", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => new Response("nope", { status: 429, headers: { "retry-after": "0.005" } }));
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(3); // the first try plus MAX_429_RETRIES
  });

  it("reports a client disconnect as tts_timeout and logs nothing", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    const ctrl = new AbortController();
    const req = postReq({ text: "hello there" }, ctrl.signal);
    ctrl.abort();
    const res = await POST(req);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "tts_timeout", engine: "openai" });
    expect(warn).not.toHaveBeenCalled(); // an abandoned turn is not a fault
  });

  it("does log an actual transport failure", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => {
      throw new TypeError("fetch failed");
    });
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "tts_error", engine: "openai" });
    expect(warn).toHaveBeenCalled();
  });

  it("reports a connect timeout as a plain tts_error, not as the client's own abort", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    serveWith(() => {
      throw new DOMException("connect timeout", "TimeoutError");
    });
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("tts_error");
  });

  it("caps concurrency at two in flight per engine so a burst cannot trip the limiter", async () => {
    setEnv({ OPENAI_API_KEY: "o" });
    const release: (() => void)[] = [];
    serveWith(() => new Promise<Response>((resolve) => release.push(() => resolve(pcmOk()))));
    const flight = [
      POST(postReq({ text: "one", stream: false })),
      POST(postReq({ text: "two", stream: false })),
      POST(postReq({ text: "three", stream: false })),
    ];
    await waitFor(() => calls.length === 2, "two requests in flight");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(2); // the third is queued behind the gate

    release[0]();
    await waitFor(() => calls.length === 3, "the third request to be admitted");
    for (const r of release) r();
    for (const res of await Promise.all(flight)) expect(res.status).toBe(200);
  });

  it("gates each engine separately — a busy engine cannot stall a different one", async () => {
    setEnv({ OPENAI_API_KEY: "o", DEEPGRAM_API_KEY: "d" });
    const release: (() => void)[] = [];
    serveWith(() => new Promise<Response>((resolve) => release.push(() => resolve(pcmOk()))));
    const busy = [
      POST(postReq({ text: "one", engine: "openai", stream: false })),
      POST(postReq({ text: "two", engine: "openai", stream: false })),
    ];
    await waitFor(() => calls.length === 2, "openai to be saturated");
    const other = POST(postReq({ text: "three", engine: "deepgram", stream: false }));
    await waitFor(() => calls.some((c) => c.url.includes("deepgram")), "deepgram to start anyway");
    for (const r of release) r();
    await new Promise((r) => setTimeout(r, 0));
    for (const r of release) r();
    for (const res of await Promise.all([...busy, other])) expect(res.status).toBe(200);
  });

  it("gemini's buffered reply becomes the same finite WAV every other engine returns", async () => {
    setEnv({ GEMINI_API_KEY: "g" });
    const pcm = bytes(32, 5);
    const b64 = Buffer.from(pcm).toString("base64");
    serveWith(() =>
      Response.json({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=16000", data: b64 } }] } }],
      }),
    );
    const res = await POST(postReq({ text: "hello there", stream: false }));
    const wav = await collect(res);
    expect(u32(wav, 24)).toBe(16_000); // the sample rate the model actually used
    expect(u32(wav, 40)).toBe(32);
    expect(wav[44]).toBe(5);
  });

  it("fails loudly when gemini answers with no audio part at all", async () => {
    setEnv({ GEMINI_API_KEY: "g" });
    serveWith(() => Response.json({ candidates: [{ content: { parts: [{ text: "I cannot do that" }] } }] }));
    const res = await POST(postReq({ text: "hello there" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "tts_error", engine: "gemini", message: "gemini returned no audio" });
  });
});
