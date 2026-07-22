"use client";

import type { RubricEntry } from "@/lib/types";
import { avgScore } from "@/lib/rubric";
import { CRITERIA, CRITERION_LABEL } from "@/lib/report-utils";
// Same dot semantics everywhere: hue = criterion token, strength = score.
import { dotOpacity } from "@/components/report/dots";

// Coach ordering: strongest criterion first, weakest last — never a list of
// failures. Evidence renders ONLY as verified pull-quotes from the candidate.

export function QuestionCard({ entry }: { entry: RubricEntry }) {
  const ordered = [...CRITERIA].sort((a, b) => entry.scores[b] - entry.scores[a]);
  const avg = avgScore(entry.scores);
  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "var(--space-2)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="small muted mono-num">
            Question {entry.questionId} · {avg.toFixed(1)}/5
          </div>
          <p style={{ margin: "4px 0 0", fontWeight: 600 }}>{entry.question}</p>
        </div>
        <span
          style={{ display: "inline-flex", gap: 6, flexShrink: 0, alignSelf: "center" }}
          aria-label={CRITERIA.map((c) => `${CRITERION_LABEL[c]} ${entry.scores[c]} of 5`).join(", ")}
        >
          {CRITERIA.map((c) => (
            <span
              key={c}
              title={`${CRITERION_LABEL[c]} ${entry.scores[c]}/5`}
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: `var(--c-${c})`,
                opacity: dotOpacity(entry.scores[c]),
                display: "inline-block",
              }}
            />
          ))}
        </span>
      </div>
      <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        {ordered.map((c) => (
          <div key={c}>
            <div className="small">
              <strong>{CRITERION_LABEL[c]}</strong>{" "}
              <span className="mono-num muted">{entry.scores[c]}/5</span>
            </div>
            {entry.evidence[c] && (
              <figure className="pullquote" style={{ margin: "6px 0" }}>
                {entry.evidence[c]}
                <figcaption
                  className="small muted"
                  style={{ fontStyle: "normal", fontFamily: "var(--font-ui)", marginTop: 2 }}
                >
                  — you
                </figcaption>
              </figure>
            )}
            {entry.tips[c] && (
              <p className="small" style={{ margin: "4px 0 0" }}>
                <strong>Try:</strong> <span className="muted">{entry.tips[c]}</span>
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
