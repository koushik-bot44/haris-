import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyUser } from "@/lib/user-store";
import { signSession } from "@/lib/session-jwt";
import { authMarkerCookie, sessionCookie } from "@/lib/auth";

// POST /api/auth/login — verify credentials, sign the session, set the cookie.
// 200 { user } | 401 generic. The 401 message never reveals whether the email
// exists — wrong email and wrong password are indistinguishable to the client.

const bodySchema = z
  .object({
    email: z.string().trim().email().max(200),
    password: z.string().min(1).max(200),
  })
  .strict();

const INVALID = "invalid email or password";

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  // A malformed email can't match any account — answer with the same generic
  // 401 rather than a validation 400, so the shape never leaks account state.
  if (!parsed.success) {
    return NextResponse.json({ error: INVALID }, { status: 401 });
  }

  let user: Awaited<ReturnType<typeof verifyUser>>;
  try {
    user = await verifyUser(parsed.data.email, parsed.data.password);
  } catch {
    return NextResponse.json({ error: "could not sign you in" }, { status: 503 });
  }

  if (!user) {
    return NextResponse.json({ error: INVALID }, { status: 401 });
  }

  const token = await signSession({ id: user.id, name: user.name });
  const res = NextResponse.json(
    { user: { id: user.id, name: user.name, email: user.email } },
    { status: 200 },
  );
  res.cookies.set(sessionCookie(token));
  res.cookies.set(authMarkerCookie());
  return res;
}
