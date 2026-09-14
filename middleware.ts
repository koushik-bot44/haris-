import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimit, isLimitedRoute, type LimitedRoute } from "@/lib/rate-limit";

// Rate-limit gate for the costed API surface. Every matched request carries a
// pds_client cookie uuid — the primary limit key (per-IP alone would self-DoS
// a campus NAT). The cookie is httpOnly and set here, but any client can send
// arbitrary cookie bytes, so the value is validated before use as a Redis key.
//
// Runs on the Node.js runtime: the Upstash client pulls Node APIs that the
// Edge runtime lacks, and nothing here needs Edge.

const COOKIE = "pds_client";
const COOKIE_MAX_AGE = 31_536_000; // 1y
const VALID_CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;

export const config = {
  runtime: "nodejs",
  matcher: [
    "/api/interview",
    "/api/score",
    "/api/gd",
    "/api/tts",
    "/api/stt",
    "/api/stt/token",
    "/api/resume-analysis",
    "/api/guidance",
    "/api/sessions",
    "/api/auth/login",
    "/api/auth/register",
  ],
};

/** "/api/stt/token" → "stt", "/api/auth/login" → "auth". */
export function routeKeyOf(pathname: string): LimitedRoute | null {
  const seg = pathname.split("/")[2] ?? "";
  return isLimitedRoute(seg) ? seg : null;
}

/** Largest request body each route can legitimately need, in bytes.
 *
 * Every route validates its body with zod — but only AFTER `req.json()` has
 * read the whole thing into memory. Driving the production build, a 6 MB JSON
 * body to /api/interview was buffered in full (523 ms) before the schema
 * refused it. Each cap is the route's own schema ceiling with headroom:
 * interview = 120 history entries × 6,000 chars + a 15,000-char résumé; gd =
 * 80 × 4,000; score = an 8,000-char answer; stt = the route's own 4 MB blob
 * cap; sessions = its own 512 KB guard. Refused on Content-Length alone, so a
 * bad request costs nothing. A chunked body with no length header passes
 * through to the route's own checks (Vercel caps request bodies at 4.5 MB
 * regardless). */
export const BODY_CAPS: Record<LimitedRoute, number> = {
  interview: 1_200_000,
  score: 64_000,
  gd: 512_000,
  tts: 16_000,
  stt: 4_500_000,
  "resume-analysis": 64_000,
  guidance: 64_000,
  sessions: 600_000,
  auth: 4_000,
};

/** True when the declared Content-Length exceeds the route's cap. */
export function bodyTooLarge(route: LimitedRoute, contentLength: string | null): boolean {
  if (!contentLength) return false;
  const n = Number(contentLength);
  return Number.isFinite(n) && n > BODY_CAPS[route];
}

export async function middleware(req: NextRequest) {
  const route = routeKeyOf(req.nextUrl.pathname);
  if (!route) return NextResponse.next();

  if (bodyTooLarge(route, req.headers.get("content-length"))) {
    return NextResponse.json({ error: "payload_too_large", message: "That request is bigger than this endpoint accepts." }, { status: 413 });
  }

  const sent = req.cookies.get(COOKIE)?.value;
  const clientId = sent && VALID_CLIENT_ID.test(sent) ? sent : crypto.randomUUID();
  const needsCookie = clientId !== sent;

  // Off-Vercel the leftmost x-forwarded-for value is client-controlled, so the
  // per-IP ceiling is a backstop only — primary = cookie key + daily budget.
  // No forwarded address at all (no reverse proxy) → null: the IP buckets are
  // skipped instead of pooling every user into one shared "local" bucket.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

  const result = await checkRateLimit(route, clientId, ip);
  const res = result.ok
    ? NextResponse.next()
    : NextResponse.json({ error: "rate_limited", message: result.message }, { status: 429 });

  if (needsCookie) {
    res.cookies.set(COOKIE, clientId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
      secure: process.env.NODE_ENV === "production",
    });
  }
  return res;
}
