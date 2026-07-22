"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getVoiceEngine, kokoroStatus, setVoiceEngine, type VoiceEngine } from "@/lib/tts";

// Landing = the setup screen (binding UX spec). No marketing hero: the round
// picker is the first thing on the page, and one real sample scorecard row sits
// above the fold as proof of what you get.

export default function SetupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [role, setRole] = useState("general");
  const [engine, setEngine] = useState<VoiceEngine>("system");
  const [elevenAvailable, setElevenAvailable] = useState(false);
  const [chatterboxAvailable, setChatterboxAvailable] = useState(false);
  const [kokoro, setKokoro] = useState("off");
  const [round, setRound] = useState<"hr" | "technical">("hr");
  const [resume, setResume] = useState("");
  const [analysis, setAnalysis] = useState<{
    strengths: string[];
    gaps: string[];
    talkingPoints: string[];
  } | null>(null);
  const [analyzer, setAnalyzer] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const analyze = async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await fetch("/api/resume-analysis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "analysis failed");
      setAnalysis(d.analysis);
      setAnalyzer(d.analyzer);
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : "analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  useEffect(() => {
    setEngine(getVoiceEngine());
    const probe = () =>
      fetch("/api/tts")
        .then((r) => r.json())
        .then((d) => {
          setElevenAvailable(Boolean(d.elevenlabs ?? d.enabled));
          setChatterboxAvailable(Boolean(d.chatterbox));
        })
        .catch(() => {});
    probe();
    const probeId = setInterval(probe, 5000); // the local voice server may come up mid-visit
    const id = setInterval(() => setKokoro(kokoroStatus()), 1000);
    return () => {
      clearInterval(id);
      clearInterval(probeId);
    };
  }, []);

  const pickEngine = (e: VoiceEngine) => {
    setEngine(e);
    setVoiceEngine(e);
  };

  const start = (which: "hr" | "technical") => {
    try {
      if (resume.trim()) window.sessionStorage.setItem("pds_resume", resume.trim());
      else window.sessionStorage.removeItem("pds_resume");
    } catch {}
    const params = new URLSearchParams({ name: name.trim() || "Candidate", role, round: which });
    router.push(`/interview?${params.toString()}`);
  };

  return (
    <main className="wrap">
      <nav className="small" style={{ display: "flex", gap: 16, marginBottom: 18 }}>
        <a href="/dashboard">Dashboard</a>
        <a href="/history">History</a>
        <a href="/progress">Progress</a>
      </nav>
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
          <button className="btn" onClick={() => start("hr")} aria-label="Start HR interview round">
            HR Interview — start
          </button>
          <button className="btn" onClick={() => start("technical")} aria-label="Start technical interview round">
            Technical — start
          </button>
          <button className="btn secondary" disabled title="The Group Discussion room — in the works">
            Group Discussion — in the works
          </button>
        </div>
        <p className="small muted" style={{ margin: "-8px 0 0" }}>
          Technical includes a hands-on coding question in a real editor.
        </p>

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

        <details>
          <summary className="small" style={{ cursor: "pointer", color: "var(--muted)" }}>
            Paste your resume (optional — the interviewer asks about YOUR projects)
          </summary>
          <div className="field" style={{ marginTop: 10 }}>
            <textarea
              rows={7}
              value={resume}
              maxLength={15000}
              onChange={(e) => setResume(e.target.value)}
              placeholder="Paste resume text here (not a file). It stays in this browser session."
            />
            <p className="small muted" style={{ margin: "4px 0 0" }}>
              Local AI processing — still, avoid pasting sensitive personal data (phone, address).
            </p>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn secondary" onClick={analyze} disabled={analyzing || resume.trim().length < 80}>
                {analyzing ? "Analyzing…" : "Analyze my resume"}
              </button>
              {analyzeError && <span className="small" style={{ color: "var(--live)" }}>{analyzeError}</span>}
            </div>
            {analysis && (
              <div className="card" style={{ marginTop: 10 }}>
                <div className="small muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Resume read{analyzer === "heuristic" ? " · basic check (brain offline)" : ""}
                </div>
                <p style={{ margin: "8px 0 2px" }}><strong>Working for you</strong></p>
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {analysis.strengths.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
                <p style={{ margin: "8px 0 2px" }}><strong>An interviewer will probe</strong></p>
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {analysis.gaps.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
                <p style={{ margin: "8px 0 2px" }}><strong>Bring these up yourself</strong></p>
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {analysis.talkingPoints.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
          </div>
        </details>

        <fieldset className="field" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px" }}>
          <legend className="small muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", padding: "0 6px" }}>
            Interviewer voice
          </legend>
          <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <input type="radio" name="voice" checked={engine === "system"} onChange={() => pickEngine("system")} />
            <span>
              System voice — <span className="muted small">instant, robotic</span>
            </span>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <input type="radio" name="voice" checked={engine === "kokoro"} onChange={() => pickEngine("kokoro")} />
            <span>
              Premium on-device (Kokoro) —{" "}
              <span className="muted small">
                natural voice, free forever, ~80MB one-time download
                {engine === "kokoro" && kokoro === "loading" && " · downloading…"}
                {engine === "kokoro" && kokoro === "ready" && " · ready ✓"}
                {engine === "kokoro" && kokoro === "failed" && " · failed — using system voice"}
              </span>
            </span>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "baseline", opacity: chatterboxAvailable ? 1 : 0.55 }}>
            <input
              type="radio"
              name="voice"
              disabled={!chatterboxAvailable}
              checked={engine === "chatterbox"}
              onChange={() => pickEngine("chatterbox")}
            />
            <span>
              Studio voice (Chatterbox, local) —{" "}
              <span className="muted small">
                {chatterboxAvailable
                  ? "server running ✓ · clone any voice at localhost:8004"
                  : "start the local voice server (~/chatterbox-tts-server)"}
              </span>
            </span>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "baseline", opacity: elevenAvailable ? 1 : 0.55 }}>
            <input
              type="radio"
              name="voice"
              disabled={!elevenAvailable}
              checked={engine === "elevenlabs"}
              onChange={() => pickEngine("elevenlabs")}
            />
            <span>
              Cloud voices (ElevenLabs) —{" "}
              <span className="muted small">
                {elevenAvailable ? "enabled" : "add ELEVENLABS_API_KEY to .env.local (free signup tier)"}
              </span>
            </span>
          </label>
        </fieldset>

        <p className="small muted">
          Voice interviews need Chrome on a laptop with a microphone. No login, nothing uploaded — your
          session stays on this device. The interviewer's brain runs locally through your Claude Code CLI;
          while the premium voice downloads, the system voice fills in.
        </p>
      </div>
    </main>
  );
}
