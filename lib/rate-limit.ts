import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Rate limiting for the API surface — env-gated. With UPSTASH_* set: sliding
// windows in Redis (correct across serverless instances). Without: an
// in-memory token bucket — per-instance only, resets on restart and does not
// coordinate across serverless instances; fine locally, Upstash required on
// Vercel. Primary key is the pds_client cookie uuid — campus NAT puts a whole
// lab behind one IP, so per-IP-only limits would self-DoS; the per-IP ceiling
// is a generous backstop against cookie-churn abuse.
//
// The daily LLM budget is PER CLIENT (plus a per-IP ceiling), never one
// global counter: a single anonymous script must not be able to switch the
// interviewer off for everybody.

export type LimitedRoute =
  | "interview"
  | "score"
  | "gd"
  | "tts"
  | "stt"
  | "resume-analysis"
  | "guidance"
  | "sessions"
  | "auth";

interface RouteRule {
  perClientPerMin: number;
  /** Counts against the daily LLM budget (tts/stt are audio, not LLM). */
  llm: boolean;
  /** Tighter per-IP ceiling for routes where cookie churn is the attack
   * (credential stuffing): a fresh cookie must not buy a fresh allowance. */
  perIpPerMin?: number;
}

export const ROUTE_RULES: Record<LimitedRoute, RouteRule> = {
  interview: { perClientPerMin: 30, llm: true },
  score: { perClientPerMin: 30, llm: true },
  gd: { perClientPerMin: 30, llm: true },
  // A turn costs at most TWO synthesis requests (see lib/speech-queue.ts), so
  // 60/min is ~30 turns/min — unreachable in a real interview. The headroom is
  // deliberate: exceeding this returns a 429 the client cannot retry, and that
  // latches the whole session to the on-device voice.
  tts: { perClientPerMin: 60, llm: false },
  // VAD-segmented transcription still fires many small requests per answer —
  // generous per minute, still bounded.
  stt: { perClientPerMin: 120, llm: false },
  "resume-analysis": { perClientPerMin: 6, llm: true },
  guidance: { perClientPerMin: 6, llm: true },
  // Persistence writes hit Mongo, not the LLM — throttled to stop storage DoS.
  sessions: { perClientPerMin: 12, llm: false },
  // Login/register: brute force protection. Per client AND per IP.
  auth: { perClientPerMin: 10, llm: false, perIpPerMin: 30 },
};

export function isLimitedRoute(v: string): v is LimitedRoute {
  return Object.prototype.hasOwnProperty.call(ROUTE_RULES, v);
}

export const IP_CEILING_PER_MIN = 300;
/** LLM calls one client may spend per day. A full round is ~40 interviewer
 * turns + ~16 background scores; this fits several rounds with headroom. */
export const DAILY_LLM_BUDGET_PER_CLIENT = 400;
/** Per-IP daily ceiling — a lab behind one NAT still gets many clients' worth. */
export const DAILY_LLM_BUDGET_PER_IP = 4000;

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
const memoryRouteIpBuckets: Partial<Record<LimitedRoute, TokenBucket>> = {};
const memoryIpBucket = new TokenBucket(IP_CEILING_PER_MIN, MINUTE_MS);
const memoryDailyClient = new TokenBucket(DAILY_LLM_BUDGET_PER_CLIENT, DAY_MS);
const memoryDailyIp = new TokenBucket(DAILY_LLM_BUDGET_PER_IP, DAY_MS);

function memoryCheck(route: LimitedRoute, clientId: string, ip: string | null): LimitResult {
  const rule = ROUTE_RULES[route];
  const bucket = (memoryClientBuckets[route] ??= new TokenBucket(rule.perClientPerMin, MINUTE_MS));
  // Per-minute buckets first: a refused request must never debit a daily
  // budget, or a throttled client could lock itself (or its lab) out for the day.
  if (!bucket.take(clientId)) return { ok: false, message: SLOW_DOWN };
  if (ip !== null) {
    if (rule.perIpPerMin) {
      const ipBucket = (memoryRouteIpBuckets[route] ??= new TokenBucket(rule.perIpPerMin, MINUTE_MS));
      if (!ipBucket.take(ip)) return { ok: false, message: SLOW_DOWN };
    }
    if (!memoryIpBucket.take(ip)) return { ok: false, message: SLOW_DOWN };
  }
  if (rule.llm) {
    if (!memoryDailyClient.take(clientId)) return { ok: false, message: QUOTA_SPENT };
    if (ip !== null && !memoryDailyIp.take(ip)) return { ok: false, message: QUOTA_SPENT };
  }
  return { ok: true };
}

// ——— Upstash path (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) ———

function upstashEnabled(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

interface UpstashLimiters {
  perRoute: Record<LimitedRoute, Ratelimit>;
  perRouteIp: Partial<Record<LimitedRoute, Ratelimit>>;
  ip: Ratelimit;
  dailyClient: Ratelimit;
  dailyIp: Ratelimit;
}

let upstashCache: UpstashLimiters | null = null;

function upstashLimiters(): UpstashLimiters {
  if (!upstashCache) {
    const redis = Redis.fromEnv();
    const routes = Object.keys(ROUTE_RULES) as LimitedRoute[];
    const perRoute = Object.fromEntries(
      routes.map((route) => [
        route,
        new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(ROUTE_RULES[route].perClientPerMin, "60 s"),
          prefix: `pds:rl:${route}`,
        }),
      ]),
    ) as Record<LimitedRoute, Ratelimit>;
    const perRouteIp: Partial<Record<LimitedRoute, Ratelimit>> = {};
    for (const route of routes) {
      const cap = ROUTE_RULES[route].perIpPerMin;
      if (cap) {
        perRouteIp[route] = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(cap, "60 s"),
          prefix: `pds:rl:${route}:ip`,
        });
      }
    }
    upstashCache = {
      perRoute,
      perRouteIp,
      ip: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(IP_CEILING_PER_MIN, "60 s"),
        prefix: "pds:rl:ip",
      }),
      dailyClient: new Ratelimit({
        redis,
        limiter: Ratelimit.fixedWindow(DAILY_LLM_BUDGET_PER_CLIENT, "1 d"),
        prefix: "pds:rl:daily:client",
      }),
      dailyIp: new Ratelimit({
        redis,
        limiter: Ratelimit.fixedWindow(DAILY_LLM_BUDGET_PER_IP, "1 d"),
        prefix: "pds:rl:daily:ip",
      }),
    };
  }
  return upstashCache;
}

async function upstashCheck(route: LimitedRoute, clientId: string, ip: string | null): Promise<LimitResult> {
  const { perRoute, perRouteIp, ip: ipLimit, dailyClient, dailyIp } = upstashLimiters();
  const ok = { success: true };
  // Per-minute keys first (independent, so in parallel); the daily budgets are
  // debited only after all pass — refusals must never drain them.
  const routeIp = perRouteIp[route];
  const [client, perIp, routePerIp] = await Promise.all([
    perRoute[route].limit(clientId),
    ip !== null ? ipLimit.limit(ip) : Promise.resolve(ok),
    ip !== null && routeIp ? routeIp.limit(ip) : Promise.resolve(ok),
  ]);
  if (!client.success || !perIp.success || !routePerIp.success) return { ok: false, message: SLOW_DOWN };
  if (ROUTE_RULES[route].llm) {
    const [dc, di] = await Promise.all([
      dailyClient.limit(clientId),
      ip !== null ? dailyIp.limit(ip) : Promise.resolve(ok),
    ]);
    if (!dc.success || !di.success) return { ok: false, message: QUOTA_SPENT };
  }
  return { ok: true };
}

let warnedUpstash = false;

/** `ip` is null when the request carried no trusted forwarded address (no
 * reverse proxy) — the IP ceilings are skipped rather than pooling every
 * user into one shared bucket; the cookie key still applies. */
export async function checkRateLimit(
  route: LimitedRoute,
  clientId: string,
  ip: string | null,
): Promise<LimitResult> {
  if (!upstashEnabled()) return memoryCheck(route, clientId, ip);
  try {
    return await upstashCheck(route, clientId, ip);
  } catch (err) {
    // Redis outage never blocks the product — degrade to the local bucket,
    // but say so once: a wrong token silently disabling distributed limits
    // is exactly the kind of failure nobody notices until the bill arrives.
    if (!warnedUpstash) {
      warnedUpstash = true;
      console.warn("[rate-limit] Upstash unreachable — falling back to per-instance limits:", err instanceof Error ? err.message : err);
    }
    return memoryCheck(route, clientId, ip);
  }
}
