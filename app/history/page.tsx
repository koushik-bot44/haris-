"use client";

// History — ONE job: sessions as rows with per-question score-dot strips.
// No cards, no mosaic (binding UX spec).

import { useEffect, useState } from "react";
import { loadSessions } from "@/lib/session-store";
import { scoreDots, sessionAvg } from "@/lib/report-utils";
import { EmptyState, ReportNav } from "@/components/ReportNav";
import type { Session } from "@/lib/types";

const DOT_COLOR = (v: number) => (v >= 4 ? "var(--ok)" : v >= 3 ? "var(--accent)" : "var(--live)");

export default function HistoryPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setSessions(loadSessions().sort((a, b) => b.startedAt - a.startedAt));
    setLoaded(true);
  }, []);
  if (!loaded) return null;

  return (
    <main className="wrap">
      <ReportNav active="history" />
      <h1>Interview history</h1>
      {sessions.length === 0 ? (
        <EmptyState message="No rounds yet — your interviews will list here with per-question score strips." />
      ) : (
        <table className="plain">
          <thead>
            <tr>
              <th>When</th>
              <th>Round</th>
              <th>Questions</th>
              <th style={{ textAlign: "right" }}>Avg</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const dots = scoreDots(s);
              const avg = sessionAvg(s);
              return (
                <tr key={s._id}>
                  <td className="mono-num">
                    {new Date(s.startedAt).toLocaleDateString()}{" "}
                    <span className="muted small">
                      {new Date(s.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </td>
                  <td>
                    {s.roundType === "technical" ? "Technical" : "HR"}
                    {s.codingUsed ? " · code" : ""}
                    {dots.length === 0 && <span className="muted small"> · unscored</span>}
                    {dots.length > 0 && dots.length < 5 && (
                      <span className="muted small"> · incomplete ({dots.length}/5)</span>
                    )}
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 5 }} aria-label={`per-question scores: ${dots.join(", ")}`}>
                      {dots.map((d, i) => (
                        <span
                          key={i}
                          title={`Q${i + 1}: ${d}/5`}
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            background: DOT_COLOR(d),
                            opacity: 0.4 + d * 0.12,
                            display: "inline-block",
                          }}
                        />
                      ))}
                    </span>
                  </td>
                  <td className="mono-num" style={{ textAlign: "right" }}>
                    {avg === null ? "—" : `${avg.toFixed(1)}/5`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
