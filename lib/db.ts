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

export async function getDb(): Promise<Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!globalForMongo._pdsMongoClient) {
    const connecting = new MongoClient(uri, { maxPoolSize: 10 }).connect();
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
    // No MONGODB_DB → the database named in the URI path (driver default).
    return client.db(process.env.MONGODB_DB);
  } catch {
    // Routes treat null as "storage disabled" — a bad MONGODB_URI must degrade
    // to 501, never surface as an unhandled 500. (Cache was un-poisoned above.)
    return null;
  }
}
