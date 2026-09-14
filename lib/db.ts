import { MongoClient, type Db } from "mongodb";

// Env-gated Mongo access. Zero env → dbEnabled() is false and getDb() returns
// null; guest/localStorage mode carries the whole app. The client promise is
// cached on globalThis: Atlas M0 caps ~500 connections, and a per-invocation
// client is the classic serverless connection storm.

const globalForMongo = globalThis as unknown as {
  _pdsMongoClient?: Promise<MongoClient>;
};

export function dbEnabled(): boolean {
  return Boolean(process.env.MONGODB_URI);
}

let warnedBadUri = false;

/** MONGODB_DB, else the database in the URI path, else "pds" — never the
 * driver's silent "test" default. */
export function databaseName(uri: string): string | undefined {
  const explicit = process.env.MONGODB_DB?.trim();
  if (explicit) return explicit;
  try {
    const path = new URL(uri).pathname.replace(/^\/+/, "");
    if (path) return undefined; // the driver reads it from the URI
  } catch {
    // unparsable — fall through to the named default
  }
  return "pds";
}

export async function getDb(): Promise<Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!globalForMongo._pdsMongoClient) {
    let connecting: Promise<MongoClient>;
    try {
      // The constructor itself throws on a malformed URI — that must degrade
      // exactly like a failed connect, never bubble up as an unhandled 500.
      connecting = new MongoClient(uri, { maxPoolSize: 10 }).connect();
    } catch (err) {
      if (!warnedBadUri) {
        warnedBadUri = true;
        console.error("[db] MONGODB_URI is invalid — persistence disabled:", err instanceof Error ? err.message : err);
      }
      return null;
    }
    // A failed connect must not poison the cache — the next request retries.
    connecting.catch(() => {
      if (globalForMongo._pdsMongoClient === connecting) {
        globalForMongo._pdsMongoClient = undefined;
      }
    });
    globalForMongo._pdsMongoClient = connecting;
  }
  try {
    const client = await globalForMongo._pdsMongoClient;
    return client.db(databaseName(uri));
  } catch {
    // Routes treat null as "storage disabled" — a bad MONGODB_URI must degrade
    // to 501, never surface as an unhandled 500. (Cache was un-poisoned above.)
    return null;
  }
}
