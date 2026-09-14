import type { ReadinessReport } from "@/lib/interview/types";

// The readiness report: verdict first, then the evidence behind it. Every score
// shown here was computed on the server from quotes verified against the
// transcript; a competency without enough evidence says so instead of showing
// a number.

const VERDICT_TONE: Record<ReadinessReport["verdict"], string> = {
  READY: "Ready for the real round",
  "ALMOST READY": "Close — a few gaps to close",
  "NEEDS PRACTICE": "Needs focused practice",
  "NOT READY": "Not ready yet",
};

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="rr-section">
      <h3 className="rr-h">{title}</h3>
      <ul className="rr-list">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

export function ReadinessReportCard({ report }: { report: ReadinessReport }) {
  const label = (id: string) => report.competencies.find((c) => c.id === id)?.label ?? id;
  return (
    <section className="card raised r-block rr" aria-label="Readiness report">
      <div className="rr-top">
        <span className={`chip rr-verdict rr-${report.verdict.replace(/\s+/g, "-").toLowerCase()}`}>{report.verdict}</span>
        {report.overall !== null && (
          <span className="rr-score mono-num" aria-label={`Overall ${report.overall} out of 10`}>
            {report.overall.toFixed(1)}
            <span className="muted">/10</span>
          </span>
        )}
      </div>
      <p className="rr-tone">{VERDICT_TONE[report.verdict]}</p>
      <p className="muted small">{report.summary}</p>

      <div className="rr-section">
        <h3 className="rr-h">Competencies</h3>
        <table className="plain rr-table">
          <tbody>
            {report.competencies.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.label}
                  {c.required ? "" : <span className="muted small"> · optional</span>}
                  {c.evidence[0] && <div className="small muted rr-quote">“{c.evidence[0]}”</div>}
                  {c.weakness && <div className="small rr-weak">{c.weakness}</div>}
                </td>
                <td className="mono-num r-right">{c.score === null ? <span className="muted small">not assessed</span> : `${c.score.toFixed(1)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <List title="Strongest areas" items={report.strongest.map(label)} />
      <List title="Weakest areas" items={report.weakest.map(label)} />
      <List title="Where you struggled" items={report.struggled.map((s) => `${s.question} — ${s.kind}`)} />
      <List title="Resume credibility" items={report.resumeFindings.map((f) => `${f.claim}: ${f.status} — ${f.detail}`)} />
      <List
        title="Contradictions to fix"
        items={report.contradictions.map((c) => `Earlier: “${c.earlier}” · Later: “${c.later}” (${c.status})`)}
      />
      <List title="Study topics" items={report.studyTopics} />
      <List title="Your practice plan" items={report.practicePlan} />
      <List title="Next interview focus" items={report.nextFocus} />
    </section>
  );
}
