import { describe, expect, it } from "vitest";
import { assertEnv, checkEnv } from "@/lib/env-check";

const SECRET = "x".repeat(40);

describe("checkEnv (production configuration guard)", () => {
  it("production without AUTH_JWT_SECRET is a fatal error", () => {
    const r = checkEnv({ NODE_ENV: "production" });
    expect(r.errors.some((e) => e.includes("AUTH_JWT_SECRET"))).toBe(true);
  });

  it("a short secret is rejected", () => {
    const r = checkEnv({ NODE_ENV: "production", AUTH_JWT_SECRET: "tooshort" });
    expect(r.errors.some((e) => e.includes("too short"))).toBe(true);
  });

  it("a proper secret passes; missing platform pieces are warnings only", () => {
    const r = checkEnv({ NODE_ENV: "production", AUTH_JWT_SECRET: SECRET, GROQ_API_KEY: "gsk_x" });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("MONGODB_URI"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("UPSTASH"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("No LLM key"))).toBe(false);
  });

  it("development never errors, but still warns about a missing brain", () => {
    const r = checkEnv({ NODE_ENV: "development" });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("No LLM key"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("No voice key"))).toBe(true);
  });

  it("a Groq key alone covers both the brain and the voice", () => {
    const r = checkEnv({ NODE_ENV: "development", GROQ_API_KEY: "gsk_x" });
    expect(r.warnings.some((w) => w.includes("No LLM key"))).toBe(false);
    expect(r.warnings.some((w) => w.includes("No voice key"))).toBe(false);
  });

  it("assertEnv throws in production on errors and returns the report otherwise", () => {
    expect(() => assertEnv({ NODE_ENV: "production" })).toThrow(/Refusing to start/);
    expect(assertEnv({ NODE_ENV: "production", AUTH_JWT_SECRET: SECRET }).errors).toEqual([]);
    expect(assertEnv({ NODE_ENV: "development" }).errors).toEqual([]);
  });

  it("flags an unknown LLM_PROVIDER", () => {
    const r = checkEnv({ NODE_ENV: "development", LLM_PROVIDER: "gemini-pro-max" });
    expect(r.warnings.some((w) => w.includes("not a known provider"))).toBe(true);
  });
});
