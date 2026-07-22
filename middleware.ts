import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimit, type LimitedRoute } from "@/lib/rate-limit";

// Rate-limit gate for the costed API surface. Every matched request carries a
// pds_client cookie uuid — the primary limit key (per-IP alone would self-DoS
// a campus NAT). The cookie is httpOnly and set here, but any client can send
// arbitrary cookie bytes, so the value is validated before use as a Redis key.

const COOKIE = "pds_client";
const COOKIE_MAX_AGE = 31_536_000; // 1y
const VALID_CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;

export const config = {
  matcher: [
    "/api/interview",
    "/api/score",
    "/api/gd",
    "/api/tts",
    "/api/resume-analysis",
    "/api/guidance",
    "/api/sessions",
  ],
};

export async function middleware(req: NextRequest) {
  const route = req.nextUrl.pathname.slice("/api/".length) as LimitedRoute;

  const sent = req.cookies.get(COOKIE)?.value;
  const clientId = sent && VALID_CLIENT_ID.test(sent) ? sent : crypto.randomUUID();
  const needsCookie = clientId !== sent;

  // Off-Vercel the leftmost x-forwarded-for value is client-controlled, so the
  // per-IP ceiling is a backstop only — primary = cookie key + daily budget.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

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
    });
  }
  return res;
}
