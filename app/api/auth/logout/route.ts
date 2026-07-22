import { NextResponse } from "next/server";
import { clearedAuthMarkerCookie, clearedSessionCookie } from "@/lib/auth";

// POST /api/auth/logout — clear both the session JWT and the readable marker.
// Always 200; signing out must never fail.

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(clearedSessionCookie());
  res.cookies.set(clearedAuthMarkerCookie());
  return res;
}
