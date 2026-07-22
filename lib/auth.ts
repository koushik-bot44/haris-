import NextAuth, { type NextAuthResult } from "next-auth";
import Google from "next-auth/providers/google";

// Env-gated auth. Zero env → authEnabled() is false, auth() resolves to
// { userId: null }, and NextAuth is never initialized — the build and every
// request path must work without AUTH_* set (guest mode is first-class).

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
  if (!authEnabled()) return { userId: null };
  try {
    const session = await nextAuth().auth();
    const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
    return { userId };
  } catch {
    // Auth failure degrades to guest — it never takes a request down.
    return { userId: null };
  }
}

/** Route handlers for app/api/auth/[...nextauth] — call only when authEnabled(). */
export function authHandlers(): NextAuthResult["handlers"] {
  return nextAuth().handlers;
}
