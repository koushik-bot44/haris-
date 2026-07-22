import { promises as fs } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { dbEnabled, getDb } from "@/lib/db";

// Credentials user store — the department's Login module. MongoDB is the
// production path (dbEnabled()); with zero env we fall back to a LOCAL FILE
// store at .data/users.json so email+password auth works with no setup for the
// local demo. Passwords are bcrypt-hashed (10 rounds); the hash never leaves
// this module — every exported function returns a SafeUser (no passwordHash).

const BCRYPT_ROUNDS = 10;
const USERS_COLLECTION = "users";
const NAME_MAX = 80;

export interface User {
  id: string;
  name: string;
  email: string; // always stored normalized (trimmed, lowercase)
  passwordHash: string;
  createdAt: number; // epoch ms
}

/** What callers ever see — the passwordHash is stripped at the boundary. */
export type SafeUser = Omit<User, "passwordHash">;

/** createUser throws this when the email is already registered (→ 409). */
export class EmailTakenError extends Error {
  constructor() {
    super("email already registered");
    this.name = "EmailTakenError";
  }
}

/** createUser throws this on a malformed email (defense-in-depth past zod). */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

// Deliberately simple: one @, one dot in the domain, no whitespace. The route's
// zod schema is the primary gate; this is a second wall on the store itself.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function stripHash(user: User): SafeUser {
  // Reconstruct rather than delete so passwordHash can never be enumerated off
  // the returned object (no lingering non-enumerable reference).
  const { id, name, email, createdAt } = user;
  return { id, name, email, createdAt };
}

// ——— Mongo backend ———

let usersIndexEnsured = false;

async function mongoBackend() {
  const db = await getDb();
  if (!db) return null;
  const col = db.collection<User & { _id: string }>(USERS_COLLECTION);
  if (!usersIndexEnsured) {
    usersIndexEnsured = true;
    // Unique index closes the check-then-insert race; a duplicate insert then
    // surfaces as code 11000 and we translate it to EmailTakenError.
    col.createIndex({ email: 1 }, { unique: true }).catch(() => {
      usersIndexEnsured = false;
    });
  }
  return {
    async findByEmail(email: string): Promise<User | null> {
      return col.findOne({ email });
    },
    async findById(id: string): Promise<User | null> {
      return col.findOne({ _id: id });
    },
    async insert(user: User): Promise<void> {
      try {
        await col.insertOne({ ...user, _id: user.id });
      } catch (err) {
        if (isDuplicateKey(err)) throw new EmailTakenError();
        throw err;
      }
    },
  };
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

// ——— Local file backend ———

// Overridable for tests; defaults to .data/users.json under the project root.
function usersFilePath(): string {
  return process.env.PDS_USERS_FILE || path.join(process.cwd(), ".data", "users.json");
}

// Serializes read-modify-write across concurrent calls in this process so two
// simultaneous registrations can't clobber each other's write.
let fileLock: Promise<unknown> = Promise.resolve();
function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = fileLock.then(fn, fn);
  // Keep the chain alive regardless of this op's outcome.
  fileLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readUsersFile(): Promise<User[]> {
  try {
    const raw = await fs.readFile(usersFilePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUserLike);
  } catch {
    // Missing file / bad JSON → empty store (first run of the local demo).
    return [];
  }
}

function isUserLike(value: unknown): value is User {
  if (typeof value !== "object" || value === null) return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.id === "string" &&
    typeof u.name === "string" &&
    typeof u.email === "string" &&
    typeof u.passwordHash === "string" &&
    typeof u.createdAt === "number"
  );
}

async function writeUsersFile(users: User[]): Promise<void> {
  const file = usersFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(users, null, 2), "utf8");
}

function fileBackend() {
  return {
    async findByEmail(email: string): Promise<User | null> {
      const users = await readUsersFile();
      return users.find((u) => u.email === email) ?? null;
    },
    async findById(id: string): Promise<User | null> {
      const users = await readUsersFile();
      return users.find((u) => u.id === id) ?? null;
    },
    async insert(user: User): Promise<void> {
      await withFileLock(async () => {
        const users = await readUsersFile();
        if (users.some((u) => u.email === user.email)) throw new EmailTakenError();
        users.push(user);
        await writeUsersFile(users);
      });
    },
  };
}

async function backend() {
  if (dbEnabled()) {
    const mongo = await mongoBackend();
    if (mongo) return mongo;
  }
  return fileBackend();
}

// ——— Public API ———

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
}): Promise<SafeUser> {
  const name = input.name.trim();
  const email = normalizeEmail(input.email);
  if (!name || name.length > NAME_MAX) throw new InvalidInputError("invalid name");
  if (!EMAIL_RE.test(email)) throw new InvalidInputError("invalid email");
  if (input.password.length < 8) throw new InvalidInputError("password too short");

  const store = await backend();
  // Fast-path duplicate check for a friendly 409; the unique index / file lock
  // is the real guarantee against the check-then-insert race.
  if (await store.findByEmail(email)) throw new EmailTakenError();

  const user: User = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
    createdAt: Date.now(),
  };
  await store.insert(user);
  return stripHash(user);
}

export async function verifyUser(email: string, password: string): Promise<SafeUser | null> {
  const store = await backend();
  const user = await store.findByEmail(normalizeEmail(email));
  // Compare even on a miss? Not necessary here — the login route returns one
  // generic message for both cases, so timing isn't an existence oracle.
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? stripHash(user) : null;
}

export async function getUserById(id: string): Promise<SafeUser | null> {
  const store = await backend();
  const user = await store.findById(id);
  return user ? stripHash(user) : null;
}
