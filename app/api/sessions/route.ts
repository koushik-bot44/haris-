import { NextResponse } from "next/server";
import { z } from "zod";
import { dbEnabled, getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { sessionSchema, toSession } from "@/lib/session-schema";
import type { Session } from "@/lib/types";

// Server persistence — env-gated. Without MONGODB_URI every response is 501
// { persisted: false, reason: "disabled" } and the client keeps localStorage
// as source of truth. IDOR policy: userId-scoped queries, 404 on miss — an
// unowned id never confirms existence. userId-null sessions are retrievable
// by exact id only (the uuid is the capability).

const postBodySchema = z.object({ session: sessionSchema });

const LIST_LIMIT = 100;
let indexEnsured = false;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = postBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid session shape", details: parsed.error.issues.map((i) => i.message).slice(0, 3) },
      { status: 400 },
    );
  }

  if (!dbEnabled()) {
    return NextResponse.json({ persisted: false, reason: "disabled" }, { status: 501 });
  }

  const db = await getDb();
  if (!db) return NextResponse.json({ persisted: false, reason: "disabled" }, { status: 501 });

  // Stamp ownership server-side — the client-sent userId is never trusted.
  const { userId } = await auth();
  const session: Session = { ...toSession(parsed.data.session), userId };

  try {
    const col = db.collection<Session>("sessions");
    // Ownership-guarded upsert: an existing doc with a different owner makes
    // the filter miss and the insert collide on _id (caught below).
    await col.replaceOne(
      { _id: session._id, userId: { $in: [null, userId] } },
      session,
      { upsert: true },
    );
    if (!indexEnsured) {
      indexEnsured = true;
      col.createIndex({ userId: 1, startedAt: -1 }).catch(() => {
        indexEnsured = false;
      });
    }
    return NextResponse.json({ persisted: true });
  } catch (err) {
    const isDuplicate = typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
    if (isDuplicate) {
      // Duplicate _id here means the id belongs to someone else. A 409 would be
      // an existence oracle; answer exactly like a miss (client is fire-and-forget).
      return NextResponse.json({ persisted: false, reason: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ persisted: false, reason: "storage_error" }, { status: 503 });
  }
}

export async function GET(req: Request) {
  if (!dbEnabled()) {
    return NextResponse.json({ error: "disabled" }, { status: 501 });
  }
  const db = await getDb();
  if (!db) return NextResponse.json({ error: "disabled" }, { status: 501 });

  const id = new URL(req.url).searchParams.get("id");
  const { userId } = await auth();
  const col = db.collection<Session>("sessions");

  try {
    if (id) {
      const session = await col.findOne({ _id: id });
      if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });
      if (session.userId !== null && session.userId !== userId) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      return NextResponse.json({ session });
    }

    if (!userId) return NextResponse.json({ error: "sign in to list sessions" }, { status: 401 });
    const sessions = await col
      .find({ userId })
      .sort({ startedAt: -1 })
      .limit(LIST_LIMIT)
      .toArray();
    return NextResponse.json({ sessions });
  } catch {
    return NextResponse.json({ error: "storage_error" }, { status: 503 });
  }
}
