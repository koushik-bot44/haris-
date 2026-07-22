"use client";

// Dashboard — ONE job (binding UX spec): "what should I fix before my next
// interview." The weakest criterion from the latest scored session, with the
// evidence quote. Not a grid of averages.

import { useEffect, useState } from "react";
import { loadSessions } from "@/lib/session-store";
import { CRITERION_LABEL, latestWeakest, scoredSessions, sessionAvg, type FixFirst } from "@/lib/report-utils";
import { EmptyState, ReportNav } from "@/components/ReportNav";
import type { Session } from "@/lib/types";

export default function DashboardPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setSessions(loadSessions());
    setLoaded(true);
  }, []);
  if (!loaded) return null;

  const fix: FixFirst | null = latestWeakest(sessions);
  const scored = scoredSessions(sessions);
  const latest = scored[scored.length - 1];

  return (
    <main className="wrap">
      <ReportNav active="dashboard" />
      <h1>Before your next interview</h1>
      {!fix || !latest ? (
        <EmptyState message="Your first scorecard will appear here — do one round and the dashboard tells you the single thing to fix next." />
      ) : (
        <>
          <div className="card" style={{ borderLeft: "3px solid var(--live)", marginBottom: 16 }}>
            <div className="small muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Fix first · {CRITERION_LABEL[fix.criterion]} {fix.score}/5
            </div>
            <p style={{ margin: "8px 0 4px" }}>
              On <em>“{fix.question}”</em>
            </p>
            {fix.evidence && (
              <blockquote style={{ margin: "8px 0", padding: "6px 12px", borderLeft: "2px solid var(--border)", fontFamily: "var(--font-display)" }}>
                “{fix.evidence}” <span className="small muted">— you</span>
              </blockquote>
            )}
            {fix.tip && <p className="small muted" style={{ margin: 0 }}>{fix.tip}</p>}
          </div>
          <p className="muted">
            Latest round: <strong className="mono-num">{sessionAvg(latest)?.toFixed(1)}/5</strong> ·{" "}
            {latest.overall.summary}
          </p>
          <p className="small muted">
            {scored.length} scored round{scored.length === 1 ? "" : "s"} on this device.{" "}
            <a href="/history">See all</a>
          </p>
        </>
      )}
    </main>
  );
}
