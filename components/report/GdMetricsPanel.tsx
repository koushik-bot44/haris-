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
    <div className="card r-block">
      <h2 style={{ marginBottom: "var(--space-2)", fontSize: "1.17rem" }}>Discussion airtime</h2>

      {totalPct > 0 && (
        <>
          {/* One stacked bar — everyone's share of the same discussion. */}
          <div className="r-airtime">
            <div
              className="r-airtime-bar"
              role="img"
              aria-label={colored.map((r) => `${r.label} ${r.pct}%`).join(", ")}
            >
              {colored.map((r) => (
                <span
                  key={r.id}
                  className="r-airtime-seg"
                  style={{ width: `${(r.pct / totalPct) * 100}%`, background: r.color }}
                />
              ))}
            </div>
            {/* The healthy-share band (AIRTIME_BAND) of total airtime, from
                the left edge — the candidate segment starts there, so the
                bracket reads directly against it. */}
            <div
              className="r-airtime-band"
              aria-hidden
              style={{ left: `${bandLo}%`, width: `${bandHi - bandLo}%` }}
            />
            <div
              className="r-airtime-band-label"
              style={{ left: `${bandLo}%`, width: `${bandHi - bandLo}%` }}
            >
              {bandLo}–{bandHi}% sweet spot
            </div>
          </div>

          <div className="r-airtime-legend">
            {colored.map((r) => (
              <span key={r.id} className="r-airtime-item">
                <span className="r-airtime-swatch" aria-hidden style={{ background: r.color }} />
                <span style={{ fontWeight: r.isCandidate ? 600 : 400 }}>{r.label}</span>
                <span className="r-airtime-pct">{r.pct}%</span>
              </span>
            ))}
          </div>
        </>
      )}

      <div className="r-stats">
        {stats.map((s) => (
          <div className="r-stat" key={s.label} title={s.title}>
            <span className="r-stat-label">{s.label}</span>
            <span className="r-stat-val">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
