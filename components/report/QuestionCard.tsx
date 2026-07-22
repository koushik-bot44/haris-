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
      <div className="r-qhead">
        <div className="r-qmeta">
          <div className="r-qnum">
            Question {entry.questionId} · {avg.toFixed(1)}/5
          </div>
          <p className="r-qtext">{entry.question}</p>
        </div>
        <span
          className="r-dots r-qdots"
          aria-label={CRITERIA.map((c) => `${CRITERION_LABEL[c]} ${entry.scores[c]} of 5`).join(", ")}
        >
          {CRITERIA.map((c) => (
            <span
              key={c}
              className="r-dot"
              title={`${CRITERION_LABEL[c]} ${entry.scores[c]}/5`}
              style={{ background: `var(--c-${c})`, opacity: dotOpacity(entry.scores[c]) }}
            />
          ))}
        </span>
      </div>
      <div className="r-crit">
        {ordered.map((c) => (
          <div key={c}>
            <div className="r-crit-head">
              <span className="r-swatch" aria-hidden style={{ background: `var(--c-${c})` }} />
              <span className="r-crit-name">{CRITERION_LABEL[c]}</span>
              <span className="r-crit-score">{entry.scores[c]}/5</span>
            </div>
            {entry.evidence[c] && (
              <figure className="pullquote" style={{ margin: "6px 0" }}>
                {entry.evidence[c]}
                <figcaption className="small muted r-attrib">— you</figcaption>
              </figure>
            )}
            {entry.tips[c] && (
              <p className="r-tip">
                <strong>Try:</strong> <span className="muted">{entry.tips[c]}</span>
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
