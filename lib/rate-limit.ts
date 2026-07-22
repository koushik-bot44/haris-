import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Rate limiting for the API surface — env-gated. With UPSTASH_* set: sliding
// windows in Redis (correct across serverless instances). Without: an
// in-memory token bucket — per-instance only, resets on restart and does not
// coordinate across serverless instances; fine locally, Upstash required on
// Vercel. Primary key is the pds_client cookie uuid — campus NAT puts a whole
// lab behind one IP, so per-IP-only limits would self-DoS; the per-IP ceiling
// is a generous backstop against cookie-churn abuse. Imported by middleware:
// must stay edge-safe (no Node-only APIs).

export type LimitedRoute =
  | "interview"
  | "score"
  | "gd"
  | "tts"
  | "resume-analysis"
  | "guidance"
  | "sessions";

interface RouteRule {
  perClientPerMin: number;
  /** Counts against the shared daily LLM budget (tts is local audio, not LLM). */
  llm: boolean;
}

export const ROUTE_RULES: Record<LimitedRoute, RouteRule> = {
  interview: { perClientPerMin: 30, llm: true },
  score: { perClientPerMin: 30, llm: true },
  gd: { perClientPerMin: 30, llm: true },
  tts: { perClientPerMin: 60, llm: false },
  "resume-analysis": { perClientPerMin: 6, llm: true },
  guidance: { perClientPerMin: 6, llm: true },
  // Persistence writes hit Mongo, not the LLM — throttled to stop storage DoS.
  sessions: { perClientPerMin: 12, llm: false },
};

export const IP_CEILING_PER_MIN = 300;
export const GLOBAL_DAILY_LLM_BUDGET = 2000;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const SLOW_DOWN = "You're going a little fast — give it a few seconds and try again.";
const QUOTA_SPENT =
  "Today's free practice budget is fully used. Come back tomorrow — the quota resets daily.";

export type LimitResult = { ok: true } | { ok: false; message: string };

/** Fixed-window token bucket. `now` is injectable for tests. */
export class TokenBucket {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  take(key: string, now: number = Date.now()): boolean {
    if (this.windows.size > 10_000) this.prune(now);
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count++;
    return true;
  }

  private prune(now: number): void {
    for (const [key, w] of this.windows) {
      if (now - w.start >= this.windowMs) this.windows.delete(key);
    }
  }
}

// ——— In-memory path (zero env) ———

const memoryClientBuckets: Partial<Record<LimitedRoute, TokenBucket>> = {};
const memoryIpBucket = new TokenBucket(IP_CEILING_PER_MIN, MINUTE_MS);
const memoryDailyBucket = new TokenBucket(GLOBAL_DAILY_LLM_BUDGET, DAY_MS);

function memoryCheck(route: LimitedRoute, clientId: string, ip: string): LimitResult {
  const rule = ROUTE_RULES[route];
  const bucket = (memoryClientBuckets[route] ??= new TokenBucket(rule.perClientPerMin, MINUTE_MS));
  // Per-client and per-IP first: a refused request must never debit the shared
  // daily budget, or one throttled client could lock everyone out.
  if (!bucket.take(clientId)) return { ok: false, message: SLOW_DOWN };
  if (!memoryIpBucket.take(ip)) return { ok: false, message: SLOW_DOWN };
  if (rule.llm && !memoryDailyBucket.take("global")) return { ok: false, message: QUOTA_SPENT };
  return { ok: true };
}

// ——— Upstash path (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) ———

function upstashEnabled(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

interface UpstashLimiters {
  perRoute: Record<LimitedRoute, Ratelimit>;
  ip: Ratelimit;
  daily: Ratelimit;
}

let upstashCache: UpstashLimiters | null = null;

function upstashLimiters(): UpstashLimiters {
  if (!upstashCache) {
    const redis = Redis.fromEnv();
    const perRoute = Object.fromEntries(
      (Object.keys(ROUTE_RULES) as LimitedRoute[]).map((route) => [
        route,
        new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(ROUTE_RULES[route].perClientPerMin, "60 s"),
          prefix: `pds:rl:${route}`,
        }),
      ]),
    ) as Record<LimitedRoute, Ratelimit>;
    upstashCache = {
      perRoute,
      ip: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(IP_CEILING_PER_MIN, "60 s"),
        prefix: "pds:rl:ip",
      }),
      daily: new Ratelimit({
        redis,
        limiter: Ratelimit.fixedWindow(GLOBAL_DAILY_LLM_BUDGET, "1 d"),
        prefix: "pds:rl:daily",
      }),
    };
  }
  return upstashCache;
}

async function upstashCheck(route: LimitedRoute, clientId: string, ip: string): Promise<LimitResult> {
  const { perRoute, ip: ipLimit, daily } = upstashLimiters();
  // Client + IP first (independent keys, so in parallel); the shared daily
  // budget is debited only after both pass — refusals must never drain it.
  const [client, perIp] = await Promise.all([perRoute[route].limit(clientId), ipLimit.limit(ip)]);
  if (!client.success || !perIp.success) return { ok: false, message: SLOW_DOWN };
  if (ROUTE_RULES[route].llm) {
    const budget = await daily.limit("global");
    if (!budget.success) return { ok: false, message: QUOTA_SPENT };
  }
  return { ok: true };
}

export async function checkRateLimit(
  route: LimitedRoute,
  clientId: string,
  ip: string,
): Promise<LimitResult> {
  if (!upstashEnabled()) return memoryCheck(route, clientId, ip);
  try {
    return await upstashCheck(route, clientId, ip);
  } catch {
    // Redis outage never blocks the product — degrade to the local bucket.
    return memoryCheck(route, clientId, ip);
  }
}
