import NextAuth, { type NextAuthResult } from "next-auth";
import Google from "next-auth/providers/google";
import { cookies } from "next/headers";
import { verifySession } from "@/lib/session-jwt";

// Primary auth = the department's email+password Login module: a stateless
// 'pds_session' JWT cookie, read here and turned into { userId }. NextAuth's
// Google provider stays as an OPTIONAL secondary that compiles with zero env —
// guest mode (userId: null) is still first-class and can never take a request
// down.

export const SESSION_COOKIE = "pds_session";
// Non-httpOnly companion the client can read to know it's signed in WITHOUT
// exposing the JWT. Carries no secret — just "1". session-store keys the
// server mirror off this.
export const AUTH_MARKER_COOKIE = "pds_auth";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, in seconds

interface CookieSpec {
  name: string;
  value: string;
  httpOnly: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
  secure: boolean;
}

// Secure only in production so the cookie still rides plain-HTTP localhost.
function secureFlag(): boolean {
  return process.env.NODE_ENV === "production";
}

export function sessionCookie(token: string): CookieSpec {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure: secureFlag(),
  };
}

export function clearedSessionCookie(): CookieSpec {
  return { ...sessionCookie(""), maxAge: 0 };
}

export function authMarkerCookie(): CookieSpec {
  return {
    name: AUTH_MARKER_COOKIE,
    value: "1",
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure: secureFlag(),
  };
}

export function clearedAuthMarkerCookie(): CookieSpec {
  return { ...authMarkerCookie(), value: "", maxAge: 0 };
}

// ——— Optional NextAuth Google (secondary) ———

export function authEnabled(): boolean {
  return Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET && process.env.AUTH_SECRET,
  );
}

let cached: NextAuthResult | null = null;

function nextAuth(): NextAuthResult {
  if (!cached) {
    cached = NextAuth({
      secret: process.env.AUTH_SECRET,
      providers: [
        Google({
          clientId: process.env.AUTH_GOOGLE_ID,
          clientSecret: process.env.AUTH_GOOGLE_SECRET,
        }),
      ],
      session: { strategy: "jwt" },
      callbacks: {
        session({ session, token }) {
          // Stable id: the Google account subject, not the mutable email.
          if (token.sub) (session.user as { id?: string }).id = `google:${token.sub}`;
          return session;
        },
      },
    });
  }
  return cached;
}

export async function auth(): Promise<{ userId: string | null }> {
  // Primary: the credentials session cookie.
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) {
      const claims = await verifySession(token);
      if (claims) return { userId: claims.userId };
    }
  } catch {
    // cookies() called outside a request scope (unit tests, edge cases) —
    // degrade to the secondary/guest path rather than throw.
  }

  // Secondary: optional Google sign-in, only when fully configured.
  if (authEnabled()) {
    try {
      const session = await nextAuth().auth();
      const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
      return { userId };
    } catch {
      // Auth failure degrades to guest — it never takes a request down.
      return { userId: null };
    }
  }

  return { userId: null };
}

/** Route handlers for app/api/auth/[...nextauth] — call only when authEnabled(). */
export function authHandlers(): NextAuthResult["handlers"] {
  return nextAuth().handlers;
}
