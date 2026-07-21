import type { DeliveryMetrics, SttTraceEvent } from "@/lib/types";

// Delivery metrics from the STT event trace. Two constraints from the plan:
// 1. Chrome STT deletes vocalized "um"/"uh" — so the filler metric counts
//    LEXICAL fillers plus hesitations (pauses), never claims um-counting.
// 2. Event gaps that span a recognizer restart are engine latency, not student
//    silence — excluded from pause detection AND from WPM active-time.

export const METRICS_VERSION = 1 as const;
export const PAUSE_THRESHOLD_MS = 2000;

const FILLER_PATTERNS = [
  /\bbasically\b/gi,
  /\bactually\b/gi,
  /\bliterally\b/gi,
  /\byou know\b/gi,
  /\bkind of\b/gi,
  /\bsort of\b/gi,
  /\blike\b/gi, // over-counts legitimate "like" — documented limitation
];

export function countFillers(transcript: string): number {
  let n = 0;
  for (const p of FILLER_PATTERNS) {
    const m = transcript.match(p);
    n += m ? m.length : 0;
  }
  return n;
}

interface SpeechPoint {
  t: number;
  afterRestart: boolean;
}

/** Extract timestamps of speech-bearing result events, marking the first event
 * after each restart so its gap can be excluded. */
function speechPoints(trace: SttTraceEvent[]): SpeechPoint[] {
  const pts: SpeechPoint[] = [];
  let restartPending = false;
  for (const ev of trace) {
    if (ev.kind === "restart") restartPending = true;
    if (ev.kind === "result" && ev.text.trim()) {
      pts.push({ t: ev.t, afterRestart: restartPending });
      restartPending = false;
    }
  }
  return pts;
}

export function computeDeliveryMetrics(trace: SttTraceEvent[], finalTranscript: string): DeliveryMetrics {
  const pts = speechPoints(trace);
  const words = finalTranscript.split(/\s+/).filter(Boolean).length;

  let longestPauseMs = 0;
  let pauseTotalMs = 0;
  let hesitationCount = 0;

  for (let i = 1; i < pts.length; i++) {
    if (pts[i].afterRestart) continue; // restart latency, not silence
    const gap = pts[i].t - pts[i - 1].t;
    if (gap > PAUSE_THRESHOLD_MS) {
      hesitationCount += 1;
      pauseTotalMs += gap;
      if (gap > longestPauseMs) longestPauseMs = gap;
    }
  }

  const spanMs = pts.length >= 2 ? pts[pts.length - 1].t - pts[0].t : 0;
  const activeMs = Math.max(spanMs - pauseTotalMs, 1);
  // Below ~3s of usable signal a rate extrapolation is noise, not measurement.
  const wpm = spanMs >= 3000 ? Math.round(words / (activeMs / 60000)) : 0;

  return {
    wpm,
    fillerCount: countFillers(finalTranscript),
    hesitationCount,
    longestPauseMs,
  };
}

/** Merge per-answer metrics into one session-level summary (word-weighted WPM
 * would need per-answer words; simple averaging is honest enough at n≤5 and
 * rounded values — the plan requires rounded display). */
export function aggregateMetrics(list: DeliveryMetrics[]): DeliveryMetrics | null {
  const usable = list.filter((m) => m.wpm > 0 || m.fillerCount > 0 || m.hesitationCount > 0);
  if (usable.length === 0) return null;
  const withRate = usable.filter((m) => m.wpm > 0);
  return {
    wpm: withRate.length ? Math.round(withRate.reduce((a, m) => a + m.wpm, 0) / withRate.length) : 0,
    fillerCount: usable.reduce((a, m) => a + m.fillerCount, 0),
    hesitationCount: usable.reduce((a, m) => a + m.hesitationCount, 0),
    longestPauseMs: Math.max(...usable.map((m) => m.longestPauseMs)),
  };
}
