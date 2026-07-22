import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/types";

// Route-level IDOR tests for /api/sessions with an in-memory Mongo stand-in.
// The fake collection honors the ownership filter and raises the duplicate-key
// code (11000) on an _id collision, exactly like the real driver.

const state = vi.hoisted(() => ({
  store: new Map<string, { _id: string; userId: string | null }>(),
  userId: null as string | null,
  dbOn: true,
}));

type Doc = { _id: string; userId: string | null };
type Filter = { _id?: string; userId?: string | null | { $in: (string | null)[] } };

function matches(doc: Doc, filter: Filter): boolean {
  if (filter._id !== undefined && doc._id !== filter._id) return false;
  if (filter.userId !== undefined) {
    const cond = filter.userId;
    if (cond !== null && typeof cond === "object") {
      if (!cond.$in.includes(doc.userId)) return false;
    } else if (doc.userId !== cond) {
      return false;
    }
  }
  return true;
}

vi.mock("@/lib/db", () => {
  const collection = {
    async replaceOne(filter: Filter, doc: Doc, opts?: { upsert?: boolean }) {
      const existing = filter._id !== undefined ? state.store.get(filter._id) : undefined;
      if (existing && matches(existing, filter)) {
        state.store.set(doc._id, doc);
        return { matchedCount: 1, upsertedId: null };
      }
      if (opts?.upsert) {
        if (state.store.has(doc._id)) {
          // Filter missed but the _id exists → unique-index violation.
          const err = new Error("E11000 duplicate key error") as Error & { code: number };
          err.code = 11000;
          throw err;
        }
        state.store.set(doc._id, doc);
        return { matchedCount: 0, upsertedId: doc._id };
      }
      return { matchedCount: 0, upsertedId: null };
    },
    async findOne(filter: Filter) {
      for (const doc of state.store.values()) if (matches(doc, filter)) return doc;
      return null;
    },
    find(filter: Filter) {
      const docs = [...state.store.values()].filter((d) => matches(d, filter));
      return {
        sort: () => ({ limit: () => ({ toArray: async () => docs }) }),
      };
    },
    createIndex: async () => "userId_1_startedAt_-1",
  };
  return {
    dbEnabled: () => state.dbOn,
    getDb: async () => (state.dbOn ? { collection: () => collection } : null),
  };
});

vi.mock("@/lib/auth", () => ({
  auth: async () => ({ userId: state.userId }),
}));

import { GET, POST } from "@/app/api/sessions/route";

function makeSession(id: string): Session {
  return {
    _id: id,
    userId: null,
    role: "general",
    roundType: "hr",
    codingUsed: false,
    startedAt: 1_700_000_000_000,
    turns: [],
    perQuestionScores: [],
    deliveryMetrics: null,
    metricsVersion: 1,
    latency: { perTurnMs: [], avgMs: null },
    overall: { avgScore: null, summary: "" },
  };
}

function postReq(session: Session): Request {
  return new Request("http://localhost/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session }),
  });
}

function getReq(id?: string): Request {
  const url = id
    ? `http://localhost/api/sessions?id=${encodeURIComponent(id)}`
    : "http://localhost/api/sessions";
  return new Request(url);
}

beforeEach(() => {
  state.store.clear();
  state.userId = null;
  state.dbOn = true;
});

describe("/api/sessions IDOR policy", () => {
  it("persists an owned session and returns it to its owner", async () => {
    state.userId = "google:owner";
    const post = await POST(postReq(makeSession("session-own-1")));
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ persisted: true });

    const get = await GET(getReq("session-own-1"));
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.session._id).toBe("session-own-1");
    // Ownership was stamped server-side, not taken from the client payload.
    expect(body.session.userId).toBe("google:owner");
  });

  it("GET ?id= for another user's session answers 404, never 403", async () => {
    state.store.set("session-owned-x", { ...makeSession("session-owned-x"), userId: "google:owner" });
    state.userId = "google:attacker";
    const res = await GET(getReq("session-owned-x"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("POST replay of another owner's _id answers the 404-shaped conflict", async () => {
    state.store.set("session-owned-x", { ...makeSession("session-owned-x"), userId: "google:owner" });
    state.userId = "google:attacker";
    const res = await POST(postReq(makeSession("session-owned-x")));
    // Indistinguishable from a miss — no existence oracle for foreign ids.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ persisted: false, reason: "not_found" });
    // The stored doc was not overwritten.
    expect(state.store.get("session-owned-x")?.userId).toBe("google:owner");
  });

  it("unauthenticated GET list answers 401", async () => {
    state.userId = null;
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it("zero-env (dbEnabled false) answers 501 on both verbs", async () => {
    state.dbOn = false;
    const post = await POST(postReq(makeSession("session-zero-env")));
    expect(post.status).toBe(501);
    expect(await post.json()).toEqual({ persisted: false, reason: "disabled" });
    const get = await GET(getReq());
    expect(get.status).toBe(501);
  });
});
