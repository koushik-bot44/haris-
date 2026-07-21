"use client";

import type { Session } from "@/lib/types";

// Guest persistence — localStorage with the same schema Mongo gets in M3, so
// the platform milestone is a storage swap, not a rewrite. Private-browsing
// mode (no localStorage) degrades to in-memory per the error registry.

const KEY = "pds_sessions_v1";
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

export function saveSession(session: Session): { persisted: boolean } {
  if (typeof window === "undefined") return { persisted: false };
  if (!storageAvailable()) {
    memoryFallback.push(session);
    return { persisted: false };
  }
  try {
    const all = loadSessions();
    all.push(session);
    window.localStorage.setItem(KEY, JSON.stringify(all));
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
    return Array.isArray(parsed) ? (parsed as Session[]) : [];
  } catch {
    return [...memoryFallback];
  }
}

export function newSessionId(): string {
  // crypto.randomUUID is available in every browser this app supports.
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.floor(performance.now() * 1000) % 100000}`;
}
