"use client";

// Progress — ONE job: the 4-criteria trend across sessions. Chart suppressed
// below 3 scored sessions (a one-dot chart is noise); rows shown instead.

import { useEffect, useState } from "react";
import { loadSessions } from "@/lib/session-store";
import { CRITERIA, CRITERION_LABEL, criterionTrend, sessionAvg, scoredSessions } from "@/lib/report-utils";
import { EmptyState, ReportNav } from "@/components/ReportNav";
import type { Session } from "@/lib/types";
import type { Criterion } from "@/lib/rubric";

const LINE_COLORS: Record<Criterion, string> = {
  relevance: "#e0a458",
  structure: "#7fa871",
  depth: "#8ba7c7",
  communication: "#c78bb4",
};

function TrendChart({ trend }: { trend: ReturnType<typeof criterionTrend> }) {
  const W = 640;
  const H = 220;
  const PAD = 28;
  const x = (i: number) => PAD + (i / Math.max(1, trend.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - 1) / 4) * (H - PAD * 2);
  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={W} height={H} role="img" aria-label="Score trend across sessions, 1 to 5, per criterion">
        {[1, 2, 3, 4, 5].map((v) => (
          <g key={v}>
            <line x1={PAD} x2={W - PAD} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} />
            <text x={6} y={y(v) + 4} fill="var(--muted)" fontSize={11}>
              {v}
            </text>
          </g>
        ))}
        {CRITERIA.map((c) => (
          <g key={c}>
            <polyline
              fill="none"
              stroke={LINE_COLORS[c]}
              strokeWidth={2}
              points={trend.map((p, i) => `${x(i)},${y(p.scores[c])}`).join(" ")}
            />
            {trend.map((p, i) => (
              <circle key={i} cx={x(i)} cy={y(p.scores[c])} r={3} fill={LINE_COLORS[c]} />
            ))}
          </g>
        ))}
      </svg>
      <div className="small" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {CRITERIA.map((c) => (
          <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 3, background: LINE_COLORS[c], display: "inline-block" }} />
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
      <ReportNav active="progress" />
      <h1>Progress</h1>
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
                  <td>{s.roundType === "technical" ? "Technical" : "HR"}</td>
                  <td className="mono-num" style={{ textAlign: "right" }}>
                    {sessionAvg(s)?.toFixed(1)}/5
                  </td>
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
