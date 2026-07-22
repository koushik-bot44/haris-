"use client";

import type { Session } from "@/lib/types";
import { AIRTIME_BAND } from "@/lib/gd/airtime";
import { formatElapsed, gdAirtimeRows } from "@/lib/report-utils";

// GD-only panel: one stacked airtime bar + participation counts, driven purely
// by session.gdMetrics — no GD-specific fetches. Candidate segment is ink;
// personas step down a neutral gray ladder (color stays reserved for data viz
// criteria and live/ok meanings).

const GRAY_MIX = [45, 32, 22, 15, 10]; // % of ink mixed into the page bg, per persona

const segmentColor = (row: { isCandidate: boolean }, personaIdx: number) =>
  row.isCandidate
    ? "var(--text)"
    : `color-mix(in oklab, var(--text) ${GRAY_MIX[personaIdx % GRAY_MIX.length]}%, var(--bg))`;

export function GdMetricsPanel({ session }: { session: Session }) {
  const m = session.gdMetrics;
  const [bandLo, bandHi] = AIRTIME_BAND;
  if (!m) return null;
  const rows = gdAirtimeRows(session);
  const totalPct = rows.reduce((a, r) => a + r.pct, 0);
  let personaIdx = -1;
  const colored = rows.map((r) => {
    if (!r.isCandidate) personaIdx += 1;
    return { ...r, color: segmentColor(r, Math.max(0, personaIdx)) };
  });

  const stats: { label: string; value: string; title?: string }[] = [
    { label: "Your turns", value: String(m.candidateTurns) },
    {
      label: "Interjections",
      value: String(m.interjections.length),
      title: "Marked on the replay below",
    },
    { label: "Speaking time", value: formatElapsed(m.candidateAirtimeMs) },
  ];

  return (
    <div className="card" style={{ margin: "var(--space-3) 0" }}>
      <h2 style={{ marginBottom: "var(--space-2)", fontSize: "1.17rem" }}>Discussion airtime</h2>

      {totalPct > 0 && (
        <>
          {/* One stacked bar — everyone's share of the same discussion. */}
          <div style={{ position: "relative", margin: "4px 0 34px" }}>
            <div
              role="img"
              aria-label={colored.map((r) => `${r.label} ${r.pct}%`).join(", ")}
              style={{ display: "flex", gap: 2, height: 12 }}
            >
              {colored.map((r) => (
                <span
                  key={r.id}
                  style={{
                    width: `${(r.pct / totalPct) * 100}%`,
                    background: r.color,
                    borderRadius: 3,
                  }}
                />
              ))}
            </div>
            {/* The healthy-share band (AIRTIME_BAND) of total airtime, from
                the left edge — the candidate segment starts there, so the
                bracket reads directly against it. */}
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: `${bandLo}%`,
                width: `${bandHi - bandLo}%`,
                top: "calc(100% + 4px)",
                height: 5,
                borderLeft: "1px solid var(--border-strong)",
                borderRight: "1px solid var(--border-strong)",
                borderBottom: "1px solid var(--border-strong)",
                borderBottomLeftRadius: 2,
                borderBottomRightRadius: 2,
              }}
            />
            <div
              className="small muted"
              style={{
                position: "absolute",
                left: `${bandLo}%`,
                width: `${bandHi - bandLo}%`,
                top: "calc(100% + 11px)",
                textAlign: "center",
                whiteSpace: "nowrap",
                fontSize: "0.72rem",
              }}
            >
              {bandLo}–{bandHi}% sweet spot
            </div>
          </div>

          <div
            className="small"
            style={{ display: "flex", gap: "6px 16px", flexWrap: "wrap", marginBottom: "var(--space-3)" }}
          >
            {colored.map((r) => (
              <span key={r.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                  aria-hidden
                  style={{ width: 9, height: 9, borderRadius: 3, background: r.color, display: "inline-block" }}
                />
                <span style={{ fontWeight: r.isCandidate ? 600 : 400 }}>{r.label}</span>
                <span className="muted mono-num">{r.pct}%</span>
              </span>
            ))}
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: "var(--space-2) var(--space-4)", flexWrap: "wrap" }}>
        {stats.map((s) => (
          <div key={s.label} title={s.title}>
            <div className="small muted">{s.label}</div>
            <div className="mono-num" style={{ fontWeight: 600, fontSize: "1.05rem" }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
