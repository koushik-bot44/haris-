"use client";

import type { Session } from "@/lib/types";

// Delivery metrics as ONE row of stats — second in the report hierarchy.
// Renders nothing when the round produced no delivery signal.

export function DeliveryRow({ session }: { session: Session }) {
  const d = session.deliveryMetrics;
  if (!d) return null;
  const stats: { label: string; value: string; title?: string }[] = [
    { label: "Pace", value: d.wpm > 0 ? `${d.wpm} wpm` : "low signal" },
    { label: "Fillers", value: String(d.fillerCount), title: "Lexical fillers (“basically”, “like”…)" },
    { label: "Hesitations", value: String(d.hesitationCount), title: "Pauses longer than 1.1s" },
    { label: "Longest pause", value: `${(d.longestPauseMs / 1000).toFixed(1)}s` },
  ];
  if (session.latency.avgMs !== null) {
    stats.push({ label: "Interviewer latency", value: `${session.latency.avgMs} ms avg` });
  }
  return (
    <div className="card tinted r-block r-stats" aria-label="Delivery metrics">
      {stats.map((s) => (
        <div className="r-stat" key={s.label} title={s.title}>
          <span className="r-stat-label">{s.label}</span>
          <span className="r-stat-val">{s.value}</span>
        </div>
      ))}
    </div>
  );
}
