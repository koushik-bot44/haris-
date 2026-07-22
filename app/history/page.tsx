"use client";

// History — ONE job: sessions as rows with per-question score-dot strips.
// No cards, no mosaic (binding UX spec). Every row links to its full report.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loadSessions } from "@/lib/session-store";
import { questionDenominator, roundLabel, scoreDots, sessionAvg } from "@/lib/report-utils";
import { EmptyState } from "@/components/ReportNav";
// Uniform ink dots — strength carries the score; color stays reserved for
// criteria/live/ok. Shared ramp with QuestionCard.
import { dotOpacity } from "@/components/report/dots";
import type { Session } from "@/lib/types";

export default function HistoryPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setSessions(loadSessions().sort((a, b) => b.startedAt - a.startedAt));
    setLoaded(true);
  }, []);
  if (!loaded) return null;

  return (
    <main className="wrap">
      <style>{`tr.row-link:hover { background: var(--surface); }`}</style>
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
              const denom = questionDenominator(s);
              return (
                // Whole row navigates; the Link in the first cell carries
                // keyboard + assistive-tech access to the same report.
                <tr
                  key={s._id}
                  className="row-link"
                  style={{ cursor: "pointer" }}
                  onClick={() => router.push(`/report/${s._id}`)}
                >
                  <td className="mono-num">
                    <Link
                      href={`/report/${s._id}`}
                      style={{ textDecoration: "none" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {new Date(s.startedAt).toLocaleDateString()}{" "}
                      <span className="muted small">
                        {new Date(s.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </Link>
                  </td>
                  <td>
                    {roundLabel(s.roundType)}
                    {s.codingUsed ? " · code" : ""}
                    {dots.length === 0 && <span className="muted small"> · unscored</span>}
                    {dots.length > 0 && dots.length < denom && (
                      <span className="muted small"> · incomplete ({dots.length}/{denom})</span>
                    )}
                  </td>
                  <td>
                    {/* role="img": a generic span may not carry aria-label. */}
                    <span
                      role="img"
                      style={{ display: "inline-flex", gap: 5 }}
                      aria-label={`per-question scores: ${dots.join(", ")}`}
                    >
                      {dots.map((d, i) => (
                        <span
                          key={i}
                          aria-hidden
                          title={`Q${i + 1}: ${d}/5`}
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            background: "var(--text)",
                            opacity: dotOpacity(d),
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
