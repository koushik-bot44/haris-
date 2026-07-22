import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySession } from "@/lib/session-jwt";
import { getUserById } from "@/lib/user-store";

// GET /api/auth/me — resolve the current session for the client shell.
// Always 200; a missing/invalid/expired cookie simply yields { user: null }.

export async function GET() {
  const nullUser = () => NextResponse.json({ user: null });

  let token: string | undefined;
  try {
    token = (await cookies()).get(SESSION_COOKIE)?.value;
  } catch {
    return nullUser();
  }
  if (!token) return nullUser();

  const claims = await verifySession(token);
  if (!claims) return nullUser();

  // Re-read the record so name/email reflect the current stored values, not a
  // possibly-stale token. A deleted account resolves to null.
  let user: Awaited<ReturnType<typeof getUserById>> = null;
  try {
    user = await getUserById(claims.userId);
  } catch {
    return nullUser();
  }
  if (!user) return nullUser();

  return NextResponse.json({ user: { id: user.id, name: user.name, email: user.email } });
}
