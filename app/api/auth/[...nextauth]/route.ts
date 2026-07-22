import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, authHandlers } from "@/lib/auth";

// NextAuth catch-all — env-gated. Without AUTH_* this responds 501 instead of
// crashing, so the zero-env deploy stays fully functional in guest mode.

function disabled() {
  return NextResponse.json(
    { error: "auth_disabled", message: "Sign-in is not configured on this deployment." },
    { status: 501 },
  );
}

export async function GET(req: NextRequest) {
  if (!authEnabled()) return disabled();
  return authHandlers().GET(req);
}

export async function POST(req: NextRequest) {
  if (!authEnabled()) return disabled();
  return authHandlers().POST(req);
}
