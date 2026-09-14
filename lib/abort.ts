// AbortSignal helpers shared by every outbound call. Two rules learned the
// hard way:
//   1. AbortSignal.any() only exists on Node ≥ 20.3 — a runtime without it must
//      not silently turn every model call into a scripted fallback.
//   2. A timeout on a STREAMED response must cover the connection only. Putting
//      AbortSignal.timeout(20s) on the whole fetch cuts a long interviewer turn
//      off mid-sentence 20 seconds in, with no error anyone can see.

export function anySignal(signals: (AbortSignal | undefined | null)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => Boolean(s));
  if (list.length === 1) return list[0];
  const AS = AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal };
  if (typeof AS.any === "function") return AS.any(list);
  const c = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

/** The caller's signal (if any) OR a deadline — for buffered calls. */
export function timeoutSignal(ms: number, signal?: AbortSignal | null): AbortSignal {
  return anySignal([signal, AbortSignal.timeout(ms)]);
}

/** fetch() whose deadline applies until the response HEADERS arrive. After
 * that the body may stream for as long as it likes; only the caller's own
 * signal (client disconnect) can still abort it. */
export async function fetchWithConnectTimeout(
  url: string,
  init: RequestInit,
  connectMs: number,
  signal?: AbortSignal | null,
): Promise<Response> {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(new DOMException("connect timeout", "TimeoutError")), connectMs);
  if (signal) {
    if (signal.aborted) c.abort(signal.reason);
    else signal.addEventListener("abort", () => c.abort(signal.reason), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(timer);
  }
}
