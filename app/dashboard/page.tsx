"use client";

// Dashboard — ONE job (binding UX spec): "what should I fix before my next
// interview." The weakest criterion from the latest scored session, with the
// evidence quote. Not a grid of averages.

import { useEffect, useState } from "react";
import Link from "next/link";
import { loadSessions } from "@/lib/session-store";
import { CRITERION_LABEL, latestWeakest, scoredSessions, sessionAvg, type FixFirst } from "@/lib/report-utils";
import { EmptyState } from "@/components/ReportNav";
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
      <h1>Before your next interview</h1>
      {!fix || !latest ? (
        <EmptyState message="Your first scorecard will appear here — do one round and the dashboard tells you the single thing to fix next." />
      ) : (
        <>
          <div className="card raised" style={{ margin: "var(--space-3) 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>Fix this first</span>
              <span className="chip">
                <span className="dot" style={{ background: `var(--c-${fix.criterion})` }} />
                {CRITERION_LABEL[fix.criterion]} <span className="mono-num">{fix.score}/5</span>
              </span>
            </div>
            <p className="small muted" style={{ margin: "8px 0 0" }}>
              On “{fix.question}”
            </p>
            {fix.evidence && (
              <figure className="pullquote">
                {fix.evidence}
                <figcaption
                  className="small muted"
                  style={{ fontStyle: "normal", fontFamily: "var(--font-ui)", marginTop: 2 }}
                >
                  — you
                </figcaption>
              </figure>
            )}
            {fix.tip && (
              <p className="small" style={{ margin: "0 0 4px" }}>
                <strong>Try:</strong> <span className="muted">{fix.tip}</span>
              </p>
            )}
            <p className="small" style={{ margin: "12px 0 0" }}>
              <Link href={`/report/${fix.sessionId}`} className="muted" style={{ textDecoration: "none" }}>
                See the full report →
              </Link>
            </p>
          </div>
          <p className="muted small">
            Latest round <strong className="mono-num" style={{ color: "var(--text)" }}>{sessionAvg(latest)?.toFixed(1)}/5</strong>{" "}
            · {scored.length} scored round{scored.length === 1 ? "" : "s"} on this device
          </p>
        </>
      )}
    </main>
  );
}
