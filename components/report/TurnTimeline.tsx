"use client";

import { useEffect, useRef } from "react";
import type { Session } from "@/lib/types";
import { formatElapsed, sessionBounds, speakerName } from "@/lib/report-utils";

// The transcript spine shared by the done-phase summary and the replay page —
// same layout skeleton; replay adds activeIndex + elapsed stamps on top.
// Speaker labels come from turn.personaName (GD personas, future 1:1
// personas), falling back to the round's default persona — never hardcoded.
// Candidate turns sit on a quiet surface block; interviewer turns stay plain.

export function TurnTimeline({
  session,
  activeIndex = null,
  showElapsed = false,
}: {
  session: Session;
  /** Replay: highlights + auto-scrolls this turn. Omit for the static list. */
  activeIndex?: number | null;
  /** Per-turn elapsed stamps ("at 2:41") instead of wall-clock time. */
  showElapsed?: boolean;
}) {
  const { start } = sessionBounds(session);
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  // Scrubbing highlights AND reveals — the active turn never sits off-screen.
  useEffect(() => {
    if (activeIndex === null || activeIndex < 0) return;
    refs.current[activeIndex]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex]);

  const interjections =
    session.roundType === "gd" ? (session.gdMetrics?.interjections ?? []) : [];
  // An interjection marker attaches to the turn whose window contains it.
  const marksFor = (i: number) => {
    const lo = i === 0 ? -Infinity : session.turns[i].tStart;
    const hi = i + 1 < session.turns.length ? session.turns[i + 1].tStart : Infinity;
    return interjections.filter((j) => start + j.tMs >= lo && start + j.tMs < hi);
  };

  return (
    <div className="r-turns">
      {session.turns.map((t, i) => {
        const active = activeIndex === i;
        const candidate = t.speaker === "candidate";
        return (
          <div
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
          >
            {marksFor(i).map((j, k) => (
              <div key={k} className="r-mark">
                <span className="r-mark-dot" aria-hidden />
                jumped in at {formatElapsed(j.tMs)}
                {j.builtOnPrevious ? " — building on the previous point" : ""}
              </div>
            ))}
            <div className={`r-turn${candidate ? " candidate" : ""}${active ? " active" : ""}`}>
              <div className="r-turn-head">
                {speakerName(t, session.roundType)}{" "}
                <span className="r-turn-time">
                  ·{" "}
                  {showElapsed
                    ? `at ${formatElapsed(t.tStart - start)}`
                    : new Date(t.tStart).toLocaleTimeString()}
                </span>
              </div>
              <p className="r-turn-text">{t.text}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
