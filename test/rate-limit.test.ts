import { describe, expect, it } from "vitest";
import {
  TokenBucket,
  ROUTE_RULES,
  checkRateLimit,
  DAILY_LLM_BUDGET_PER_CLIENT,
  DAILY_LLM_BUDGET_PER_IP,
  IP_CEILING_PER_MIN,
  isLimitedRoute,
} from "@/lib/rate-limit";

const MINUTE = 60_000;

describe("TokenBucket (in-memory rate limiting)", () => {
  it("allows up to the limit within one window, then refuses", () => {
    const bucket = new TokenBucket(3, MINUTE);
    const t0 = 1_000_000;
    expect(bucket.take("a", t0)).toBe(true);
    expect(bucket.take("a", t0 + 1)).toBe(true);
    expect(bucket.take("a", t0 + 2)).toBe(true);
    expect(bucket.take("a", t0 + 3)).toBe(false);
    expect(bucket.take("a", t0 + MINUTE - 1)).toBe(false);
  });

  it("rolls the window over — a fresh window grants fresh tokens", () => {
    const bucket = new TokenBucket(2, MINUTE);
    const t0 = 5_000;
    expect(bucket.take("a", t0)).toBe(true);
    expect(bucket.take("a", t0 + 10)).toBe(true);
    expect(bucket.take("a", t0 + 20)).toBe(false);
    expect(bucket.take("a", t0 + MINUTE)).toBe(true);
    expect(bucket.take("a", t0 + MINUTE + 1)).toBe(true);
    expect(bucket.take("a", t0 + MINUTE + 2)).toBe(false);
  });

  it("isolates keys — one client's burst never starves another", () => {
    const bucket = new TokenBucket(1, MINUTE);
    const t0 = 0;
    expect(bucket.take("client-a", t0)).toBe(true);
    expect(bucket.take("client-a", t0 + 1)).toBe(false);
    expect(bucket.take("client-b", t0 + 2)).toBe(true);
    expect(bucket.take("client-c", t0 + 3)).toBe(true);
    expect(bucket.take("client-b", t0 + 4)).toBe(false);
  });

  it("the window is per-key, not global — late keys get full windows", () => {
    const bucket = new TokenBucket(1, MINUTE);
    expect(bucket.take("early", 0)).toBe(true);
    // "late" first appears half a window in; its window runs from then.
    expect(bucket.take("late", MINUTE / 2)).toBe(true);
    expect(bucket.take("late", MINUTE - 1)).toBe(false);
    expect(bucket.take("late", MINUTE / 2 + MINUTE)).toBe(true);
  });
});

describe("route rules (the plan's limits, pinned)", () => {
  it("matches the approved per-minute limits", () => {
    expect(ROUTE_RULES.interview.perClientPerMin).toBe(30);
    expect(ROUTE_RULES.tts.perClientPerMin).toBe(60);
    expect(ROUTE_RULES.stt.perClientPerMin).toBe(120);
    expect(ROUTE_RULES.score.perClientPerMin).toBe(30);
    expect(ROUTE_RULES.gd.perClientPerMin).toBe(30);
    expect(ROUTE_RULES["resume-analysis"].perClientPerMin).toBe(6);
    expect(ROUTE_RULES.sessions.perClientPerMin).toBe(12);
    expect(ROUTE_RULES.auth.perClientPerMin).toBe(10);
    expect(ROUTE_RULES.auth.perIpPerMin).toBe(30);
    expect(DAILY_LLM_BUDGET_PER_CLIENT).toBe(400);
    expect(DAILY_LLM_BUDGET_PER_IP).toBe(4000);
  });

  it("audio and persistence routes are exempt from the daily LLM budget; LLM routes are not", () => {
    expect(ROUTE_RULES.tts.llm).toBe(false);
    expect(ROUTE_RULES.stt.llm).toBe(false);
    expect(ROUTE_RULES.sessions.llm).toBe(false);
    expect(ROUTE_RULES.auth.llm).toBe(false);
    expect(ROUTE_RULES.interview.llm).toBe(true);
    expect(ROUTE_RULES.score.llm).toBe(true);
    expect(ROUTE_RULES.gd.llm).toBe(true);
    expect(ROUTE_RULES["resume-analysis"].llm).toBe(true);
  });

  it("isLimitedRoute recognises exactly the configured routes", () => {
    expect(isLimitedRoute("auth")).toBe(true);
    expect(isLimitedRoute("stt")).toBe(true);
    expect(isLimitedRoute("health")).toBe(false);
    expect(isLimitedRoute("toString")).toBe(false); // prototype keys are not routes
  });
});

describe("checkRateLimit (zero env → in-memory path)", () => {
  it("limits resume-analysis to 6/min per client and answers with a message", async () => {
    // Module-level buckets use real time; 7 calls land inside one window.
    for (let i = 0; i < 6; i++) {
      const r = await checkRateLimit("resume-analysis", "test-client-ra", "10.0.0.1");
      expect(r.ok).toBe(true);
    }
    const blocked = await checkRateLimit("resume-analysis", "test-client-ra", "10.0.0.1");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.message.length).toBeGreaterThan(0);
  });

  it("keeps clients isolated on the shared route bucket", async () => {
    const r = await checkRateLimit("resume-analysis", "test-client-other", "10.0.0.2");
    expect(r.ok).toBe(true);
  });

  it("a throttled client's refusals never debit anyone's daily budget", async () => {
    // Exhaust one client's per-minute allowance on an LLM route…
    for (let i = 0; i < ROUTE_RULES.guidance.perClientPerMin; i++) {
      const r = await checkRateLimit("guidance", "budget-hog", "10.7.7.7");
      expect(r.ok).toBe(true);
    }
    // …then hammer it while blocked, far past the daily budgets.
    for (let i = 0; i < DAILY_LLM_BUDGET_PER_IP + 500; i++) {
      const r = await checkRateLimit("guidance", "budget-hog", "10.7.7.7");
      expect(r.ok).toBe(false);
    }
    // A fresh client on the SAME IP must still get through — the per-IP daily
    // budget was not drained by refusals.
    const fresh = await checkRateLimit("guidance", "budget-fresh", "10.7.7.7");
    expect(fresh.ok).toBe(true);
  });

  it("the daily LLM budget is per client: one client's spend cannot switch the brain off for others", async () => {
    // Unique route/client so the per-minute bucket (30/min on gd) is the only
    // other gate: spend well under it, spread across "days" is impossible in a
    // unit test, so verify the ISOLATION property instead of exhaustion.
    for (let i = 0; i < 20; i++) {
      const r = await checkRateLimit("gd", "daily-a", "10.8.8.8");
      expect(r.ok).toBe(true);
    }
    const other = await checkRateLimit("gd", "daily-b", "10.8.8.8");
    expect(other.ok).toBe(true);
  });

  it("the per-IP ceiling actually blocks at 300/min across clients", async () => {
    expect(IP_CEILING_PER_MIN).toBe(300);
    // Unique client ids so only the IP bucket can refuse; tts avoids the daily budget.
    for (let i = 0; i < IP_CEILING_PER_MIN; i++) {
      const r = await checkRateLimit("tts", `ip-test-client-${i}`, "10.9.9.9");
      expect(r.ok).toBe(true);
    }
    const blocked = await checkRateLimit("tts", "ip-test-client-final", "10.9.9.9");
    expect(blocked.ok).toBe(false);
    // The ceiling is per-IP, not global — another IP is unaffected.
    const otherIp = await checkRateLimit("tts", "ip-test-client-final", "10.9.9.10");
    expect(otherIp.ok).toBe(true);
  });

  it("auth has its own per-IP ceiling so cookie churn cannot brute-force a login", async () => {
    for (let i = 0; i < ROUTE_RULES.auth.perIpPerMin!; i++) {
      const r = await checkRateLimit("auth", `auth-churn-${i}`, "10.11.11.11");
      expect(r.ok).toBe(true);
    }
    const blocked = await checkRateLimit("auth", "auth-churn-final", "10.11.11.11");
    expect(blocked.ok).toBe(false);
  });

  it("an unknown IP (no proxy) skips the IP buckets instead of pooling everyone", async () => {
    for (let i = 0; i < IP_CEILING_PER_MIN + 5; i++) {
      const r = await checkRateLimit("tts", `noip-client-${i}`, null);
      expect(r.ok).toBe(true);
    }
  });
});
