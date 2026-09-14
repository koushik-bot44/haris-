import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InterviewRequest, InterviewerTurn } from "@/lib/types";

// /api/interview identity wiring.
//
// This is the end of the defect that made long-term memory dead code: the route
// handed the provider `memoryKey: userId`, and with no MONGODB_URI there are no
// accounts, so userId was null on literally every request and the provider
// skipped recall AND remember every single time. The interviewer could not
// avoid repeating a question because it was never told who it was talking to.

const state = vi.hoisted(() => ({
  userId: null as string | null,
  seen: [] as { memoryKey?: string | null; speculative?: boolean }[],
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ userId: state.userId }) }));

vi.mock("@/lib/llm", () => ({
  getProvider: () => ({
    name: "test",
    async nextTurn(_req: InterviewRequest, opts?: { memoryKey?: string | null; speculative?: boolean }) {
      state.seen.push({ memoryKey: opts?.memoryKey, speculative: opts?.speculative });
      return { type: "question", text: "Why us?", questionIndex: 1, done: false } satisfies InterviewerTurn;
    },
  }),
}));

import { POST } from "@/app/api/interview/route";
import { GUEST_COOKIE, readGuestId } from "@/lib/memory";

function post(cookie?: string): Request {
  return new Request("http://localhost/api/interview", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({
      role: "general",
      roundType: "hr",
      candidateName: "Hari",
      history: [
        { speaker: "interviewer", text: "Hi Hari." },
        { speaker: "candidate", text: "Hello." },
      ],
    }),
  });
}

/** The guest id the response tells the browser to keep, if any. */
function mintedId(res: Response): string | null {
  const header = res.headers.get("set-cookie");
  return header ? readGuestId(header.split(";")[0]) : null;
}

beforeEach(() => {
  state.userId = null;
  state.seen = [];
});

describe("/api/interview long-term memory identity", () => {
  it("gives a guest with no cookie a durable id and passes it as the memory subject", async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    const id = mintedId(res);
    expect(id).not.toBeNull();
    // The whole point: not null any more.
    expect(state.seen[0].memoryKey).toBe(id);
  });

  it("sets the cookie so it actually survives — path, a year, and not readable by script", async () => {
    const header = (await POST(post())).headers.get("set-cookie") ?? "";
    expect(header).toContain(`${GUEST_COOKIE}=guest-`);
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=31536000");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
  });

  it("reuses the id the browser sends back, and stops re-issuing it", async () => {
    const first = await POST(post());
    const id = mintedId(first)!;
    const second = await POST(post(`${GUEST_COOKIE}=${id}`));
    expect(state.seen[1].memoryKey).toBe(id);
    // Nothing changed, so nothing to say — no Set-Cookie on every later turn.
    expect(second.headers.get("set-cookie")).toBeNull();
  });

  it("keeps two browsers apart — a guest must never read another guest's history", async () => {
    const a = mintedId(await POST(post()))!;
    const b = mintedId(await POST(post()))!;
    expect(a).not.toBe(b);
  });

  it("replaces a junk or forged cookie value instead of using it as a storage key", async () => {
    const res = await POST(post(`${GUEST_COOKIE}=../../../etc/passwd`));
    const id = mintedId(res);
    expect(id).not.toBeNull();
    expect(state.seen[0].memoryKey).toBe(id);
  });

  it("prefers the signed-in user when there is one, and mints no guest cookie", async () => {
    state.userId = "google:12345";
    const res = await POST(post(`${GUEST_COOKIE}=guest-abcd-1234-efgh`));
    expect(state.seen[0].memoryKey).toBe("google:12345");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("carries the identity on the streamed path too, not just the JSON one", async () => {
    const req = new Request("http://localhost/api/interview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        role: "general",
        roundType: "hr",
        candidateName: "Hari",
        history: [{ speaker: "interviewer", text: "Hi." }, { speaker: "candidate", text: "Hello." }],
        stream: true,
      }),
    });
    const res = await POST(req);
    await res.text(); // drain, so the provider call completes
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(mintedId(res)).not.toBeNull();
    expect(state.seen[0].memoryKey).toBe(mintedId(res));
  });

  it("still marks a speculative pre-fetch, so it is never written to memory", async () => {
    const req = new Request("http://localhost/api/interview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        role: "general",
        roundType: "hr",
        candidateName: "Hari",
        history: [{ speaker: "interviewer", text: "Hi." }, { speaker: "candidate", text: "Hello." }],
        speculative: true,
      }),
    });
    await POST(req);
    expect(state.seen[0].speculative).toBe(true);
  });
});
