import { NextResponse } from "next/server";
import { z } from "zod";
import { createUser, EmailTakenError, InvalidInputError } from "@/lib/user-store";
import { signSession } from "@/lib/session-jwt";
import { authMarkerCookie, sessionCookie } from "@/lib/auth";

// POST /api/auth/register — create an account, sign the session, set the cookie.
// 200 { user } | 409 email taken | 400 invalid input | 503 storage error.

const bodySchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(80),
    email: z.string().trim().email("enter a valid email").max(200),
    password: z.string().min(8, "password must be at least 8 characters").max(200),
  })
  .strict();

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid input" },
      { status: 400 },
    );
  }

  try {
    const user = await createUser(parsed.data);
    const token = await signSession({ id: user.id, name: user.name });
    const res = NextResponse.json(
      { user: { id: user.id, name: user.name, email: user.email } },
      { status: 200 },
    );
    res.cookies.set(sessionCookie(token));
    res.cookies.set(authMarkerCookie());
    return res;
  } catch (err) {
    if (err instanceof EmailTakenError) {
      return NextResponse.json({ error: "that email is already registered" }, { status: 409 });
    }
    if (err instanceof InvalidInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "could not create your account" }, { status: 503 });
  }
}
