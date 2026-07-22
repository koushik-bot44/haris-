"use client";

import { useEffect, useState } from "react";
import type { RubricEntry } from "@/lib/types";
import { avgScore } from "@/lib/rubric";

// The verdict — always FIRST in the report hierarchy (binding spec):
// big average + the coach summary, never a wall of numbers.

const TOO_SHORT =
  "Answers were too short to score this round — aim for 30+ seconds per answer. Transcript and " +
  "delivery numbers below.";

/** Count-up on mount (~600ms rAF); instant when the user prefers reduced motion. */
function useCountUp(target: number): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const DURATION = 600;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return value;
}

export function ScoreVerdict({
  entries,
  summary,
  unscoredNote,
}: {
  entries: RubricEntry[];
  summary: string;
  unscoredNote?: string;
}) {
  const avg =
    entries.length > 0 ? entries.reduce((a, e) => a + avgScore(e.scores), 0) / entries.length : null;
  if (avg === null) return <p className="muted">{unscoredNote ?? TOO_SHORT}</p>;
  return <Verdict avg={avg} summary={summary} />;
}

function Verdict({ avg, summary }: { avg: number; summary: string }) {
  const shown = useCountUp(avg);
  return (
    <div className="card raised" style={{ margin: "var(--space-3) 0" }}>
      <div
        className="display mono-num"
        aria-label={`Overall score ${avg.toFixed(1)} out of 5`}
        style={{ fontSize: "2.8rem", lineHeight: 1, fontWeight: 500 }}
      >
        <span aria-hidden>{shown.toFixed(1)}</span>
        <span aria-hidden className="muted" style={{ fontSize: "1.2rem" }}>
          /5
        </span>
      </div>
      <p
        className="display"
        style={{ margin: "10px 0 0", fontStyle: "italic", fontSize: "1.05rem", lineHeight: 1.5 }}
      >
        {summary}
      </p>
    </div>
  );
}
