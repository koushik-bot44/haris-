"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Landing = the setup screen (binding UX spec). No marketing hero: the round
// picker is the first thing on the page, and one real sample scorecard row sits
// above the fold as proof of what you get.

export default function SetupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [role, setRole] = useState("general");

  const start = () => {
    const params = new URLSearchParams({ name: name.trim() || "Candidate", role });
    router.push(`/interview?${params.toString()}`);
  };

  return (
    <main className="wrap">
      <h1>Pick your round</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        A voice interview with real feedback — spoken questions, adaptive follow-ups, and a scorecard built
        from your own words.
      </p>

      {/* Proof, before the first click: a real sample scorecard row. */}
      <div className="card" style={{ margin: "20px 0", borderLeft: "3px solid var(--accent)" }}>
        <div className="small muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Sample feedback — structure 4/5
        </div>
        <p style={{ margin: "6px 0 0", fontFamily: "var(--font-display)", fontSize: "1.05rem" }}>
          “I split the migration into three checkpoints so we could roll back at each stage” — clear
          situation-action-result shape. Lead with the outcome next time to score 5.
        </p>
      </div>

      <div style={{ display: "grid", gap: "20px", maxWidth: 440 }}>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <button className="btn" onClick={start} aria-label="Start HR interview round">
            HR Interview — start
          </button>
          <button className="btn secondary" disabled title="Arrives with M2 (September)">
            Technical — coming soon
          </button>
          <button className="btn secondary" disabled title="The Group Discussion room — in the works">
            Group Discussion — in the works
          </button>
        </div>

        <div className="field">
          <label htmlFor="name">Your name (the interviewer uses it)</label>
          <input
            id="name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Hari"
          />
        </div>

        <div className="field">
          <label htmlFor="role">Target role</label>
          <select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="general">General fresher</option>
            <option value="java-sde-fresher">Java SDE fresher</option>
            <option value="frontend-fresher">Frontend fresher</option>
          </select>
        </div>

        <p className="small muted">
          Voice interviews need Chrome on a laptop with a microphone. No login, nothing uploaded — your
          session stays on this device. Free-tier AI processing arrives later; today runs fully offline
          against a practice interviewer.
        </p>
      </div>
    </main>
  );
}
