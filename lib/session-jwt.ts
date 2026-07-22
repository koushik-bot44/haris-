import { SignJWT, jwtVerify } from "jose";

// Stateless session tokens — a jose HS256 JWT holding only { sub: userId, name }.
// The secret comes from AUTH_JWT_SECRET; a documented dev fallback keeps the
// local demo running with zero setup. SET AUTH_JWT_SECRET IN PRODUCTION — the
// fallback is public, so a token signed with it is trivially forgeable.

const DEV_SECRET =
  "pds-dev-insecure-secret-do-not-use-in-production-set-AUTH_JWT_SECRET-please";
const ALG = "HS256";
const EXPIRY = "7d";

function secretKey(): Uint8Array {
  return new TextEncoder().encode(process.env.AUTH_JWT_SECRET || DEV_SECRET);
}

export interface SessionClaims {
  userId: string;
  name: string;
}

/** Signs a 7-day session token for the given user. */
export async function signSession(user: { id: string; name: string }): Promise<string> {
  return new SignJWT({ name: user.name })
    .setProtectedHeader({ alg: ALG })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(secretKey());
}

/** Verifies a token; returns its claims, or null for tampered/expired/garbage. */
export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: [ALG] });
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    const name = typeof payload.name === "string" ? payload.name : "";
    return { userId: payload.sub, name };
  } catch {
    // Bad signature, expired exp, malformed — all degrade to "no session".
    return null;
  }
}
