import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";

// The module reads AUTH_JWT_SECRET at call time, so pinning it before import
// lets us forge expired / wrong-secret tokens with the same key.
const SECRET = "test-secret-for-session-jwt-unit-tests-0123456789";
process.env.AUTH_JWT_SECRET = SECRET;

import { signSession, verifySession } from "@/lib/session-jwt";

const key = new TextEncoder().encode(SECRET);
const nowSec = () => Math.floor(Date.now() / 1000);

describe("session jwt", () => {
  it("round-trips: sign then verify yields the claims", async () => {
    const token = await signSession({ id: "u_123", name: "Sai G" });
    expect(await verifySession(token)).toEqual({ userId: "u_123", name: "Sai G" });
  });

  it("rejects a tampered token", async () => {
    const token = await signSession({ id: "u_1", name: "A" });
    // Mutate the signature segment — the HMAC no longer matches the payload.
    const tampered = `${token}x`;
    expect(await verifySession(tampered)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({ name: "Old" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u_exp")
      .setIssuedAt(nowSec() - 60 * 60 * 24 * 8)
      .setExpirationTime(nowSec() - 60) // expired a minute ago
      .sign(key);
    expect(await verifySession(expired)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const wrongKey = new TextEncoder().encode("a-completely-different-secret-value");
    const token = await new SignJWT({ name: "X" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u_wrong")
      .setExpirationTime("7d")
      .sign(wrongKey);
    expect(await verifySession(token)).toBeNull();
  });

  it("rejects a token with no subject", async () => {
    const noSub = await new SignJWT({ name: "Nameless" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .sign(key);
    expect(await verifySession(noSub)).toBeNull();
  });

  it("returns null for garbage input", async () => {
    expect(await verifySession("")).toBeNull();
    expect(await verifySession("not-a-jwt")).toBeNull();
    expect(await verifySession("a.b.c")).toBeNull();
  });
});
