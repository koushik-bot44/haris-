"use client";

import type { Session } from "@/lib/types";

// Guest persistence — localStorage with the same schema Mongo gets, so the
// platform milestone is a storage swap, not a rewrite. Private-browsing mode
// (no localStorage) degrades to in-memory per the error registry.

const KEY = "pds_sessions_v1";
// Unbounded transcripts eventually blow the ~5MB quota — keep only the most
// recent rounds, and shrink further when a write still does not fit.
const MAX_STORED_SESSIONS = 100;
const MIN_STORED_SESSIONS = 5;
const memoryFallback: Session[] = [];

function storageAvailable(): boolean {
  try {
    const k = "__pds_probe__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

const ROUND_TYPES = new Set(["hr", "technical", "gd"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isTurnLike(v: unknown): boolean {
  return isRecord(v) && typeof v.speaker === "string" && typeof v.text === "string" && typeof v.tStart === "number" && typeof v.tEnd === "number";
}

function isScoresLike(v: unknown): boolean {
  return (
    isRecord(v) &&
    ["relevance", "structure", "depth", "communication"].every((k) => typeof v[k] === "number" && Number.isFinite(v[k] as number))
  );
}

function isRubricEntryLike(v: unknown): boolean {
  return (
    isRecord(v) &&
    typeof v.questionId === "number" &&
    typeof v.question === "string" &&
    typeof v.answerTranscript === "string" &&
    isScoresLike(v.scores) &&
    isRecord(v.evidence ?? {}) &&
    isRecord(v.tips ?? {})
  );
}

// Stored payloads are user-editable JSON — entries missing the load-bearing
// fields (or with malformed nested shapes every report view dereferences) are
// dropped rather than crashing every reporting page.
function isSessionLike(value: unknown): value is Session {
  if (!isRecord(value)) return false;
  const s = value;
  return (
    typeof s._id === "string" &&
    typeof s.startedAt === "number" &&
    typeof s.role === "string" &&
    typeof s.roundType === "string" &&
    ROUND_TYPES.has(s.roundType) &&
    Array.isArray(s.turns) &&
    s.turns.every(isTurnLike) &&
    Array.isArray(s.perQuestionScores) &&
    s.perQuestionScores.every(isRubricEntryLike) &&
    (s.deliveryMetrics === null || s.deliveryMetrics === undefined || isRecord(s.deliveryMetrics)) &&
    isRecord(s.overall) &&
    typeof s.overall.summary === "string" &&
    isRecord(s.latency) &&
    Array.isArray(s.latency.perTurnMs)
  );
}

// Login gates persistence (approved plan): the UI promises guests that
// nothing leaves the device, so only a signed-in browser may mirror to the
// server. Guests never POST. The real credential ('pds_session' JWT) is
// httpOnly and invisible to JS, so we read the non-secret 'pds_auth=1' marker
// the login/register routes set alongside it. The legacy Auth.js token is kept
// as a fallback for any Google-signed-in session.
function hasAuthCookie(): boolean {
  try {
    const c = typeof document !== "undefined" ? document.cookie : "";
    return (
      c.includes("pds_auth=") ||
      c.includes("authjs.session-token") ||
      c.includes("__Secure-authjs.session-token")
    );
  } catch {
    return false;
  }
}

// Fire-and-forget server mirror — the persisted flag stays localStorage
// truth, so every failure mode here (network, 501, no fetch) is swallowed.
function postSession(session: Session): void {
  if (!hasAuthCookie()) return;
  try {
    void fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    }).catch(() => {});
  } catch {
    // fetch unavailable — server mirroring is best-effort only.
  }
}

function readStored(): Session[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter(isSessionLike) : [];
  } catch {
    return [];
  }
}

export function saveSession(session: Session): { persisted: boolean } {
  if (typeof window === "undefined") return { persisted: false };
  postSession(session);
  if (!storageAvailable()) {
    memoryFallback.push(session);
    return { persisted: false };
  }
  // Shrink-and-retry: a quota failure drops the oldest rounds until the new
  // one fits (down to a small floor) instead of permanently degrading every
  // later save to memory-only.
  let keep = [...readStored(), session].slice(-MAX_STORED_SESSIONS);
  for (;;) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(keep));
      return { persisted: true };
    } catch {
      if (keep.length <= MIN_STORED_SESSIONS) break;
      keep = keep.slice(1);
    }
  }
  memoryFallback.push(session);
  return { persisted: false };
}

/** Every round visible on this device: stored rounds plus any that only made
 * it to memory this tab (storage full/blocked), so History and the summary
 * page agree with the round the user just finished. */
export function loadSessions(): Session[] {
  if (typeof window === "undefined" || !storageAvailable()) return [...memoryFallback];
  const stored = readStored();
  const ids = new Set(stored.map((s) => s._id));
  const extra = memoryFallback.filter((s) => !ids.has(s._id));
  return extra.length ? [...stored, ...extra] : stored;
}

export function getSession(id: string): Session | null {
  const fromStore = loadSessions().find((s) => s._id === id);
  if (fromStore) return fromStore;
  // Storage may be healthy while THIS round only made it to memory.
  return memoryFallback.find((s) => s._id === id) ?? null;
}

export function newSessionId(): string {
  // crypto.randomUUID is available in every browser this app supports.
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.floor(performance.now() * 1000) % 100000}`;
}
