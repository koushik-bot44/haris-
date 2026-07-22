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
    <div
      className="card tinted"
      aria-label="Delivery metrics"
      style={{
        margin: "var(--space-3) 0",
        display: "flex",
        gap: "var(--space-2) var(--space-4)",
        flexWrap: "wrap",
      }}
    >
      {stats.map((s) => (
        <div key={s.label} title={s.title}>
          <div className="small muted">{s.label}</div>
          <div className="mono-num" style={{ fontWeight: 600, fontSize: "1.05rem" }}>
            {s.value}
          </div>
        </div>
      ))}
    </div>
  );
}
