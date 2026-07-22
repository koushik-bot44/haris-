"use client";

import type { Session } from "@/lib/types";

// Guest persistence — localStorage with the same schema Mongo gets in M3, so
// the platform milestone is a storage swap, not a rewrite. Private-browsing
// mode (no localStorage) degrades to in-memory per the error registry.

const KEY = "pds_sessions_v1";
// Unbounded transcripts eventually blow the ~5MB quota and permanently
// degrade saves to memory-only — keep only the most recent rounds.
const MAX_STORED_SESSIONS = 100;
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

// Stored payloads are user-editable JSON — entries missing the load-bearing
// fields are dropped rather than crashing every reporting view.
function isSessionLike(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s._id === "string" &&
    typeof s.startedAt === "number" &&
    Array.isArray(s.turns) &&
    Array.isArray(s.perQuestionScores)
  );
}

// Login gates persistence (approved plan): the UI promises guests that
// nothing leaves the device, so only a signed-in browser (Auth.js session
// cookie present) may mirror to the server. Guests never POST.
function hasAuthCookie(): boolean {
  try {
    const c = typeof document !== "undefined" ? document.cookie : "";
    return c.includes("authjs.session-token") || c.includes("__Secure-authjs.session-token");
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

export function saveSession(session: Session): { persisted: boolean } {
  if (typeof window === "undefined") return { persisted: false };
  postSession(session);
  if (!storageAvailable()) {
    memoryFallback.push(session);
    return { persisted: false };
  }
  try {
    const all = loadSessions();
    all.push(session);
    window.localStorage.setItem(KEY, JSON.stringify(all.slice(-MAX_STORED_SESSIONS)));
    return { persisted: true };
  } catch {
    memoryFallback.push(session);
    return { persisted: false };
  }
}

export function loadSessions(): Session[] {
  if (typeof window === "undefined" || !storageAvailable()) return [...memoryFallback];
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter(isSessionLike) : [];
  } catch {
    return [...memoryFallback];
  }
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
