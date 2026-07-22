import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// The store reads MONGODB_URI + PDS_USERS_FILE at call time, so unsetting the
// former forces the local file backend and pointing the latter at a temp file
// keeps every test hermetic.
let dir: string;
let file: string;

beforeAll(async () => {
  delete process.env.MONGODB_URI; // force the .data/users.json file backend
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pds-users-"));
  file = path.join(dir, "users.json");
  process.env.PDS_USERS_FILE = file;
});

afterEach(async () => {
  await fs.rm(file, { force: true });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

import {
  createUser,
  verifyUser,
  getUserById,
  normalizeEmail,
  EmailTakenError,
  InvalidInputError,
} from "@/lib/user-store";

describe("user store (file backend)", () => {
  it("creates a user, normalizes the email, and never returns the hash", async () => {
    const u = await createUser({ name: "Sai G", email: "Sai@Example.COM", password: "hunter2pass" });
    expect(u.email).toBe("sai@example.com");
    expect(u.name).toBe("Sai G");
    expect(u.id).toBeTruthy();
    expect((u as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it("verifies the correct password and rejects the wrong one", async () => {
    const u = await createUser({ name: "A", email: "verify@example.com", password: "correcthorse" });
    const ok = await verifyUser("VERIFY@example.com", "correcthorse"); // email is case-insensitive
    expect(ok?.id).toBe(u.id);
    expect((ok as Record<string, unknown> | null)?.passwordHash).toBeUndefined();
    expect(await verifyUser("verify@example.com", "wrongpassword")).toBeNull();
  });

  it("returns null for an unknown email", async () => {
    expect(await verifyUser("nobody@example.com", "whateverpass")).toBeNull();
  });

  it("rejects a duplicate email case-insensitively", async () => {
    await createUser({ name: "First", email: "dupe@example.com", password: "password1" });
    await expect(
      createUser({ name: "Second", email: "DUPE@Example.com", password: "password2" }),
    ).rejects.toBeInstanceOf(EmailTakenError);
  });

  it("getUserById round-trips; unknown id is null", async () => {
    const u = await createUser({ name: "Ida", email: "ida@example.com", password: "password1" });
    expect((await getUserById(u.id))?.email).toBe("ida@example.com");
    expect(await getUserById("no-such-id")).toBeNull();
  });

  it("rejects malformed input past the route's zod gate", async () => {
    await expect(
      createUser({ name: "X", email: "notanemail", password: "longenough1" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      createUser({ name: "X", email: "x@example.com", password: "short" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      createUser({ name: "   ", email: "space@example.com", password: "longenough1" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("persists to disk as a bcrypt hash, never plaintext, and reads back", async () => {
    await createUser({ name: "P", email: "persist@example.com", password: "s3cretpassword" });
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Array<{
      email: string;
      passwordHash: string;
    }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].email).toBe("persist@example.com");
    expect(raw[0].passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt signature
    expect(raw[0].passwordHash).not.toContain("s3cretpassword");
    // A subsequent call re-reads the file (no in-memory cache).
    expect(await verifyUser("persist@example.com", "s3cretpassword")).not.toBeNull();
  });

  it("normalizeEmail trims and lowercases", () => {
    expect(normalizeEmail("  MixedCase@Example.com  ")).toBe("mixedcase@example.com");
  });
});
