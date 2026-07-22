"use client";

// Full report for one session — verdict → delivery row → per-question cards →
// replay (binding hierarchy). Reads the guest store first; falls back to the
// server copy (pinned /api/sessions contract) when this device lacks the round.

import { type CSSProperties, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getSession } from "@/lib/session-store";
import {
  activeTurnIndex,
  formatElapsed,
  roundLabel,
  sessionBounds,
} from "@/lib/report-utils";
import { EmptyState } from "@/components/ReportNav";
import { ReportStyles } from "@/components/report/ReportStyles";
import { ScoreVerdict } from "@/components/report/ScoreVerdict";
import { DeliveryRow } from "@/components/report/DeliveryRow";
import { QuestionCard } from "@/components/report/QuestionCard";
import { TurnTimeline } from "@/components/report/TurnTimeline";
import { GdMetricsPanel } from "@/components/report/GdMetricsPanel";
import type { Session } from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; session: Session };

export default function ReportPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const local = getSession(sessionId);
    if (local) {
      setState({ kind: "ready", session: local });
      return;
    }
    // Not on this device — the server copy may have it. 501 means persistence
    // is disabled server-side; every failure lands on the same not-found state.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sessions?id=${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { session?: Session };
        if (!cancelled) {
          setState(body.session ? { kind: "ready", session: body.session } : { kind: "missing" });
        }
      } catch {
        if (!cancelled) setState({ kind: "missing" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (state.kind === "loading") return null;

  if (state.kind === "missing") {
    return (
      <main className="wrap">
        <h1>Interview report</h1>
        <EmptyState
          message="Can't find that round — guest reports live on the device where the interview happened. Your rounds on THIS device are all in History."
          cta="See your history"
          href="/history"
        />
      </main>
    );
  }

  const s = state.session;
  return (
    <main className="wrap">
      <ReportStyles />
      <h1 className="r-title">Interview report</h1>
      <div className="r-meta">
        <span className="chip">{roundLabel(s.roundType)} round</span>
        <span className="chip mono-num">
          {new Date(s.startedAt).toLocaleDateString()}{" "}
          {new Date(s.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
        {s.topic ? (
          <span className="chip">
            <span className="r-clip">“{s.topic}”</span>
          </span>
        ) : null}
      </div>

      <ScoreVerdict
        entries={s.perQuestionScores}
        summary={s.overall.summary}
        unscoredNote={
          s.roundType === "gd"
            ? "Group discussions aren't scored per question — your participation numbers are below."
            : undefined
        }
      />

      <DeliveryRow session={s} />

      {s.roundType === "gd" && <GdMetricsPanel session={s} />}

      {s.perQuestionScores.length > 0 && (
        <section className="r-section">
          <h2>Question by question</h2>
          <div className="r-qgrid">
            {s.perQuestionScores.map((e) => (
              <QuestionCard key={e.questionId} entry={e} />
            ))}
          </div>
        </section>
      )}

      <Replay session={s} />
    </main>
  );
}

// The replay: the shared turn timeline with a scrubber mapped over
// [session start → end]. Turn-level precision only — no word sync.
function Replay({ session }: { session: Session }) {
  const { start, end } = sessionBounds(session);
  const duration = Math.max(0, end - start);
  const [pos, setPos] = useState(0); // ms since session start
  const active = activeTurnIndex(session.turns, start + pos);

  if (session.turns.length === 0 || duration <= 0) {
    return (
      <section className="r-section">
        <h2>Replay</h2>
        <p className="muted">No transcript was recorded for this round.</p>
      </section>
    );
  }

  const fillPct = duration > 0 ? (pos / duration) * 100 : 0;
  return (
    <section className="r-section">
      <h2>Replay</h2>
      <div className="r-scrub-row">
        {/* Native range input: draggable AND keyboard-operable (arrow keys).
            --fill paints the elapsed portion of the WebKit track. */}
        <input
          type="range"
          className="r-scrub"
          min={0}
          max={duration}
          step={1000}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label="Replay position"
          aria-valuetext={`${formatElapsed(pos)} of ${formatElapsed(duration)}`}
          style={{ ["--fill" as string]: `${fillPct}%` } as CSSProperties}
        />
        <span className="small muted r-scrub-time">
          {formatElapsed(pos)} / {formatElapsed(duration)}
        </span>
      </div>
      <TurnTimeline session={session} activeIndex={active} showElapsed />
    </section>
  );
}
