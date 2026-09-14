import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { InterviewState } from "@/lib/interview/types";
import type { HistoryEntry } from "@/lib/types";

// Interview state travels as a signed, compressed token.
//
// Why a token and not a server-side session store: this deployment runs on
// serverless functions with no guaranteed database (no MONGODB_URI on Vercel)
// and in-memory state does not survive across instances. A signed payload
// keeps every turn stateless on the server while making the state
// tamper-proof — the client carries it but cannot edit a score, a coverage
// number or a claim without the signature failing. The token is also bound to
// the transcript it was computed on (historyHash), so it cannot be replayed
// against an edited history.

const PREFIX = "is1";
const DEV_SECRET = "pds-dev-insecure-interview-state-secret-set-AUTH_JWT_SECRET";
/** A state older than this is refused and rebuilt from the transcript. */
export const STATE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Inflate ceiling — a forged tiny payload must not expand into a memory bomb. */
const MAX_JSON_BYTES = 1_000_000;

function key(): Buffer {
  const configured = process.env.AUTH_JWT_SECRET?.trim();
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_JWT_SECRET must be set in production");
  }
  // Domain-separated from the session JWT key: a state token can never be
  // presented as a login, or the reverse.
  return createHash("sha256").update(`pds-interview-state-v1:${configured || DEV_SECRET}`).digest();
}

export function historyHash(history: readonly HistoryEntry[], length = history.length): string {
  const h = createHash("sha256");
  for (let i = 0; i < Math.min(length, history.length); i++) {
    const e = history[i];
    h.update(`${e.speaker === "interviewer" ? "i" : "c"}:${e.text.length}:${e.text}\n`);
  }
  return h.digest("base64url").slice(0, 32);
}

export function signState(state: InterviewState): string {
  const payload = deflateRawSync(Buffer.from(JSON.stringify(state), "utf8")).toString("base64url");
  const sig = createHmac("sha256", key()).update(`${PREFIX}.${payload}`).digest("base64url");
  return `${PREFIX}.${payload}.${sig}`;
}

/** The state inside a token, or null when it is forged, expired, malformed or
 * from another version. Never throws on bad input. */
export function verifyState(token: unknown, now: number): InterviewState | null {
  if (typeof token !== "string" || token.length > 200_000) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    const expected = createHmac("sha256", key()).update(`${PREFIX}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const json = inflateRawSync(Buffer.from(parts[1], "base64url"), { maxOutputLength: MAX_JSON_BYTES }).toString("utf8");
    const state = JSON.parse(json) as InterviewState;
    if (!state || state.v !== 1 || typeof state.createdAt !== "number" || !state.plan || !state.ledger) return null;
    if (now - state.createdAt > STATE_MAX_AGE_MS || state.createdAt - now > 60_000) return null;
    return state;
  } catch {
    return null;
  }
}
