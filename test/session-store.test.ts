import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/types";

// The store keeps module-level memory state, so every test gets a fresh
// import via resetModules; window/fetch are stubbed per test (node env).

function makeSession(id: string, startedAt = 1): Session {
  return {
    _id: id,
    userId: null,
    role: "general",
    roundType: "hr",
    codingUsed: false,
    startedAt,
    turns: [],
    perQuestionScores: [],
    deliveryMetrics: null,
    metricsVersion: 1,
    latency: { perTurnMs: [], avgMs: null },
    overall: { avgScore: null, summary: "" },
  };
}

const KEY = "pds_sessions_v1";

function stubBrowser(opts: { broken?: boolean; authed?: boolean } = {}) {
  const map = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (opts.broken) throw new Error("quota");
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
  vi.stubGlobal("window", { localStorage });
  // Auth.js session cookie gates the server mirror — guests have none.
  vi.stubGlobal("document", { cookie: opts.authed ? "__Secure-authjs.session-token=tok" : "pds_client=abc" });
  return { map };
}

async function freshStore() {
  vi.resetModules();
  return import("@/lib/session-store");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session store", () => {
  it("saveSession persists to localStorage and getSession finds it", async () => {
    stubBrowser();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const store = await freshStore();
    const s = makeSession("abc");
    expect(store.saveSession(s)).toEqual({ persisted: true });
    expect(store.loadSessions()).toHaveLength(1);
    expect(store.getSession("abc")?._id).toBe("abc");
    expect(store.getSession("nope")).toBeNull();
  });

  it("guest save (no auth cookie) never POSTs the transcript anywhere", async () => {
    stubBrowser();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const store = await freshStore();
    expect(store.saveSession(makeSession("abc")).persisted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signed-in save (auth cookie present) mirrors to /api/sessions with the pinned body", async () => {
    stubBrowser({ authed: true });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const store = await freshStore();
    store.saveSession(makeSession("abc"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).session._id).toBe("abc");
  });

  it("a rejected or missing fetch never blocks the persisted flag", async () => {
    stubBrowser({ authed: true });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    let store = await freshStore();
    expect(store.saveSession(makeSession("a")).persisted).toBe(true);

    vi.stubGlobal("fetch", undefined);
    store = await freshStore();
    expect(store.saveSession(makeSession("b")).persisted).toBe(true);
  });

  it("caps localStorage at the 100 most recent sessions", async () => {
    stubBrowser();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const store = await freshStore();
    for (let i = 0; i < 101; i++) store.saveSession(makeSession(`s${i}`, i));
    const all = store.loadSessions();
    expect(all).toHaveLength(100);
    expect(all[0]._id).toBe("s1"); // the oldest (s0) was evicted
    expect(all[99]._id).toBe("s100");
  });

  it("loadSessions drops malformed entries instead of blind-casting", async () => {
    const { map } = stubBrowser();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    map.set(
      KEY,
      JSON.stringify([
        makeSession("good"),
        null,
        "junk",
        { _id: 42, startedAt: 1, turns: [], perQuestionScores: [] },
        { _id: "no-turns", startedAt: 1, perQuestionScores: [] },
        { _id: "no-start", turns: [], perQuestionScores: [] },
      ]),
    );
    const store = await freshStore();
    const loaded = store.loadSessions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]._id).toBe("good");
  });

  it("broken storage degrades to memory: persisted false, still readable this tab", async () => {
    stubBrowser({ broken: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const store = await freshStore();
    expect(store.saveSession(makeSession("mem")).persisted).toBe(false);
    expect(store.loadSessions().map((s) => s._id)).toEqual(["mem"]);
    expect(store.getSession("mem")?._id).toBe("mem");
  });

  it("a quota failure shrinks the stored list and retries instead of giving up", async () => {
    const { map } = stubBrowser();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    // Storage that refuses anything over ~12 sessions' worth of bytes.
    const realSet = (k: string, v: string) => map.set(k, v);
    const limit = JSON.stringify(Array.from({ length: 12 }, (_, i) => makeSession(`s${i}`, i))).length;
    (globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } }).window.localStorage.setItem = (
      k: string,
      v: string,
    ) => {
      if (k === KEY && v.length > limit) throw new Error("QuotaExceededError");
      realSet(k, v);
    };
    const store = await freshStore();
    for (let i = 0; i < 20; i++) expect(store.saveSession(makeSession(`s${i}`, i)).persisted).toBe(true);
    const all = store.loadSessions();
    expect(all.length).toBeLessThanOrEqual(12);
    expect(all[all.length - 1]._id).toBe("s19"); // the newest round always survives
  });

  it("memory-only rounds still appear in loadSessions when storage is otherwise healthy", async () => {
    const { map } = stubBrowser();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    let failNext = false;
    const realSet = (k: string, v: string) => map.set(k, v);
    (globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } }).window.localStorage.setItem = (
      k: string,
      v: string,
    ) => {
      if (k === KEY && failNext) throw new Error("quota");
      realSet(k, v);
    };
    const store = await freshStore();
    expect(store.saveSession(makeSession("stored")).persisted).toBe(true);
    failNext = true;
    expect(store.saveSession(makeSession("memory-only")).persisted).toBe(false);
    expect(store.loadSessions().map((s) => s._id)).toEqual(["stored", "memory-only"]);
  });

  it("drops entries whose nested shapes would crash the report views", async () => {
    const { map } = stubBrowser();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const bad = { ...makeSession("bad-scores"), perQuestionScores: [{ questionId: 1, question: "q", answerTranscript: "a", scores: { relevance: "x" } }] };
    const badOverall = { ...makeSession("bad-overall"), overall: null };
    map.set(KEY, JSON.stringify([makeSession("good"), bad, badOverall]));
    const store = await freshStore();
    expect(store.loadSessions().map((s) => s._id)).toEqual(["good"]);
  });
});
