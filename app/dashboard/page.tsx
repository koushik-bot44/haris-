"use client";

// Dashboard — ONE job (binding UX spec): "what should I fix before my next
// interview." The weakest criterion from the latest scored session, with the
// evidence quote. Not a grid of averages.

import { useEffect, useState } from "react";
import Link from "next/link";
import { loadSessions } from "@/lib/session-store";
import { CRITERION_LABEL, latestWeakest, scoredSessions, sessionAvg, type FixFirst } from "@/lib/report-utils";
import { EmptyState } from "@/components/ReportNav";
import { ReportStyles } from "@/components/report/ReportStyles";
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
      <ReportStyles />
      <h1 className="r-title">Before your next interview</h1>
      <p className="r-lead tight">The one thing to sharpen before you walk in, drawn from your latest scored round.</p>
      {!fix || !latest ? (
        <EmptyState message="Your first scorecard will appear here — do one round and the dashboard tells you the single thing to fix next." />
      ) : (
        <>
          <div className="card raised r-block">
            <div className="r-fix-head">
              <span className="r-fix-title">Fix this first</span>
              <span className="chip">
                <span className="dot" style={{ background: `var(--c-${fix.criterion})` }} />
                {CRITERION_LABEL[fix.criterion]} <span className="mono-num">{fix.score}/5</span>
              </span>
            </div>
            <p className="small muted r-fix-q">On “{fix.question}”</p>
            {fix.evidence && (
              <figure className="pullquote">
                {fix.evidence}
                <figcaption className="small muted r-attrib">— you</figcaption>
              </figure>
            )}
            {fix.tip && (
              <p className="r-fix-tip">
                <strong>Try:</strong> <span className="muted">{fix.tip}</span>
              </p>
            )}
            <p style={{ margin: "16px 0 0" }}>
              <Link href={`/report/${fix.sessionId}`} className="r-arrow">
                See the full report →
              </Link>
            </p>
          </div>
          <p className="r-summary">
            Latest round <strong>{sessionAvg(latest)?.toFixed(1)}/5</strong> · {scored.length} scored
            round{scored.length === 1 ? "" : "s"} on this device
          </p>
        </>
      )}
    </main>
  );
}
