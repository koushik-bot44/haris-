import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { BODY_CAPS, bodyTooLarge, middleware } from "@/middleware";

// Oversized bodies are refused on Content-Length alone, before any route reads
// them. Driving the production build, a 6 MB JSON body to /api/interview was
// buffered in full (523 ms) before zod refused it — a cheap way for one client
// to tie up memory on the app's most expensive endpoint. The caps sit above
// every route's own schema ceiling, so no legitimate request is affected.

function post(path: string, length: number | null) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(length === null ? {} : { "content-length": String(length) }),
    },
  });
}

describe("bodyTooLarge", () => {
  it.each([
    ["interview", 1_200_000, false],
    ["interview", 1_200_001, true],
    ["tts", 16_000, false],
    ["tts", 6_000_000, true],
    ["stt", 4_000_000, false],
    ["stt", 4_600_000, true],
    ["auth", 4_000, false],
    ["auth", 4_001, true],
  ] as const)("%s at %d bytes → tooLarge=%s", (route, length, expected) => {
    expect(bodyTooLarge(route, String(length))).toBe(expected);
  });

  it("a missing or garbage Content-Length is not refused here (the route still validates)", () => {
    expect(bodyTooLarge("interview", null)).toBe(false);
    expect(bodyTooLarge("interview", "")).toBe(false);
    expect(bodyTooLarge("interview", "not-a-number")).toBe(false);
  });

  it("every cap is above the route's own schema ceiling", () => {
    // 120 history entries × 6,000 chars + a 15,000-char résumé, with headroom.
    expect(BODY_CAPS.interview).toBeGreaterThan(120 * 6_000 + 15_000);
    expect(BODY_CAPS.gd).toBeGreaterThan(80 * 4_000);
    expect(BODY_CAPS.score).toBeGreaterThan(8_000 + 1_200);
    expect(BODY_CAPS.stt).toBeGreaterThan(4 * 1024 * 1024);
  });
});

describe("middleware — payload cap", () => {
  it("answers 413 JSON for an oversized body without touching the rate limiter", async () => {
    const res = await middleware(post("/api/interview", 6 * 1024 * 1024));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("payload_too_large");
    expect(body.message).toMatch(/bigger than/);
    // No pds_client cookie is minted for a refused request.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("lets a normal-sized body through to the route", async () => {
    const res = await middleware(post("/api/interview", 20_000));
    expect(res.status).toBe(200); // NextResponse.next()
  });

  it("does not gate paths outside the costed API surface", async () => {
    const res = await middleware(post("/api/health", 10_000_000));
    expect(res.status).toBe(200);
  });
});
