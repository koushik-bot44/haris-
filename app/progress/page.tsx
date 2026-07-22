"use client";

// Progress — ONE job: the 4-criteria trend across sessions. Chart suppressed
// below 3 scored sessions (a one-dot chart is noise); rows shown instead.

import { useEffect, useState } from "react";
import { loadSessions } from "@/lib/session-store";
import { CRITERIA, CRITERION_LABEL, criterionTrend, roundLabel, sessionAvg, scoredSessions } from "@/lib/report-utils";
import { EmptyState } from "@/components/ReportNav";
import { ReportStyles } from "@/components/report/ReportStyles";
import type { Session } from "@/lib/types";

// Criterion tokens are the only data colors — inline SVG resolves CSS vars
// directly, so stroke="var(--c-…)" needs no JS color plumbing.

function TrendChart({ trend }: { trend: ReturnType<typeof criterionTrend> }) {
  // Fixed coordinate space, fluid rendering — viewBox + width:100% scales to
  // the wrap column instead of forcing a horizontal scroll.
  const W = 640;
  const H = 232;
  const PAD = 28;
  const x = (i: number) => PAD + (i / Math.max(1, trend.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - 14 - ((v - 1) / 4) * (H - PAD * 2 - 14);
  const baseline = y(1);
  // Thin x labels so long histories never overlap; endpoints always shown.
  const labelEvery = Math.max(1, Math.ceil(trend.length / 6));
  return (
    <div className="card r-block">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label="Score trend across sessions, 1 to 5, per criterion"
      >
        {[1, 2, 3, 4, 5].map((v) => (
          <g key={v}>
            <line x1={PAD} x2={W - PAD} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} />
            <text x={6} y={y(v) + 4} fill="var(--muted)" fontSize={11}>
              {v}
            </text>
          </g>
        ))}
        {trend.map((p, i) =>
          i % labelEvery === 0 || i === trend.length - 1 ? (
            <text key={i} x={x(i)} y={H - 8} fill="var(--muted)" fontSize={10} textAnchor="middle">
              {new Date(p.t).toLocaleDateString([], { month: "short", day: "numeric" })}
            </text>
          ) : null,
        )}
        {CRITERIA.map((c) => {
          const line = trend.map((p, i) => `${x(i)},${y(p.scores[c])}`).join(" ");
          const area = `${line} ${x(trend.length - 1)},${baseline} ${x(0)},${baseline}`;
          return (
            <g key={c}>
              <polygon fill={`var(--c-${c})`} fillOpacity={0.06} stroke="none" points={area} />
              <polyline fill="none" stroke={`var(--c-${c})`} strokeWidth={2} points={line} />
              {trend.map((p, i) => (
                <circle key={i} cx={x(i)} cy={y(p.scores[c])} r={3} fill={`var(--c-${c})`} />
              ))}
            </g>
          );
        })}
      </svg>
      <div className="r-trend-legend">
        {CRITERIA.map((c) => (
          <span key={c} className="r-trend-item">
            <span className="r-swatch" aria-hidden style={{ background: `var(--c-${c})` }} />
            {CRITERION_LABEL[c]}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ProgressPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setSessions(loadSessions());
    setLoaded(true);
  }, []);
  if (!loaded) return null;

  const scored = scoredSessions(sessions);
  const trend = criterionTrend(sessions);

  return (
    <main className="wrap">
      <ReportStyles />
      <h1 className="r-title">Progress</h1>
      <p className="r-lead tight">How your four scoring criteria move across every scored round.</p>
      {scored.length === 0 ? (
        <EmptyState message="Progress tracking starts with your first scored round." />
      ) : scored.length < 3 ? (
        <>
          <p className="muted">
            The trend chart unlocks at 3 scored rounds — {3 - scored.length} more to go. So far:
          </p>
          <table className="plain">
            <tbody>
              {scored.map((s) => (
                <tr key={s._id}>
                  <td className="mono-num">{new Date(s.startedAt).toLocaleDateString()}</td>
                  <td>{roundLabel(s.roundType)}</td>
                  <td className="mono-num r-right">{sessionAvg(s)?.toFixed(1)}/5</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <TrendChart trend={trend} />
      )}
    </main>
  );
}
