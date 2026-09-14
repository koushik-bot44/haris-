// In-memory cache for SHORT synthesized lines. The acks ("Mm, okay."), the
// nudges ("Mm-hm — go on?") and short interviewer lines repeat in every
// session; synthesizing them again burns the per-minute budget that decides
// whether the NEXT sentence is voiced by the studio engine or by the browser's
// robotic floor. Bounded LRU, process lifetime, keyed by engine + voice + text.

const MAX_ENTRIES = 96;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/** Only lines this short are cached — long turns are unique anyway. */
export const CACHEABLE_TEXT_MAX = 160;

const cache = new Map<string, Uint8Array<ArrayBuffer>>();
let totalBytes = 0;

export function ttsCacheKey(engine: string, voiceKey: string, text: string): string {
  return `${engine}|${voiceKey}|${text.trim().replace(/\s+/g, " ")}`;
}

export function ttsCacheGet(key: string): Uint8Array<ArrayBuffer> | null {
  const hit = cache.get(key);
  if (!hit) return null;
  // Refresh recency.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

export function ttsCacheSet(key: string, bytes: Uint8Array<ArrayBuffer>): void {
  if (bytes.length === 0 || bytes.length > MAX_TOTAL_BYTES / 4) return;
  const old = cache.get(key);
  if (old) {
    totalBytes -= old.length;
    cache.delete(key);
  }
  cache.set(key, bytes);
  totalBytes += bytes.length;
  while (cache.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    totalBytes -= cache.get(oldest)!.length;
    cache.delete(oldest);
  }
}

export function ttsCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: totalBytes };
}

/** Test/ops helper. */
export function ttsCacheClear(): void {
  cache.clear();
  totalBytes = 0;
}
