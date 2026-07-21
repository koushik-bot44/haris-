"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useInterviewMachine } from "@/hooks/useInterviewMachine";
import type { RolePreset } from "@/lib/types";

export default function InterviewPage() {
  return (
    <Suspense fallback={null}>
      <InterviewRoom />
    </Suspense>
  );
}

function InterviewRoom() {
  const params = useSearchParams();
  const router = useRouter();
  const name = params.get("name")?.slice(0, 60) || "Candidate";
  const role = (["general", "java-sde-fresher", "frontend-fresher"].includes(params.get("role") ?? "")
    ? params.get("role")
    : "general") as RolePreset;

  const m = useInterviewMachine(name, role);
  const [textDraft, setTextDraft] = useState("");

  // Leaving mid-interview loses the answer in progress — warn (UX spec).
  useEffect(() => {
    const inProgress = !["done", "micCheck", "preroll"].includes(m.phase);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (inProgress) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [m.phase]);

  // Keyboard: Enter ends the current answer (voice mode). Keyboard-first per a11y floor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && m.phase === "listening" && !m.textMode) {
        e.preventDefault();
        m.endAnswerNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [m]);

  const leave = () => {
    m.cleanup();
    router.push("/");
  };

  return (
    <main className="wrap">
      <header style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 28 }}>
        <div className={`monogram ${m.phase === "speaking" ? "speaking" : ""}`} aria-hidden>
          PS
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "1.1rem" }}>Priya Sharma</div>
          <div className="small muted">HR · Meridian Corp — mock round</div>
        </div>
        {m.questionIndex > 0 && m.phase !== "done" && (
          <div className="small muted mono-num">Question {m.questionIndex} of 5</div>
        )}
        <button className="btn secondary" onClick={leave}>
          Leave
        </button>
      </header>

      {m.phase === "micCheck" && <MicCheck m={m} />}
      {m.phase === "preroll" && <Preroll m={m} />}
      {(m.phase === "thinking" || m.phase === "speaking" || m.phase === "listening") && (
        <Live m={m} textDraft={textDraft} setTextDraft={setTextDraft} />
      )}
      {m.phase === "connectionLost" && (
        <section className="card" role="alert">
          <h2>The interviewer lost connection</h2>
          <p className="muted">Your answers are safe. You can try again — the round continues where it left off.</p>
          <button className="btn" onClick={m.retryConnection}>
            Try again
          </button>
        </section>
      )}
      {m.phase === "done" && <Summary m={m} />}

      <p className="small muted" style={{ marginTop: 40 }}>
        Keep this tab active during the interview — browsers pause speech in background tabs.
      </p>
    </main>
  );
}

type M = ReturnType<typeof useInterviewMachine>;

function MicCheck({ m }: { m: M }) {
  const started = m.micCheckTranscript.length > 0 || m.hearing;
  return (
    <section className="card">
      <h2>Quick mic check</h2>
      {!m.textMode ? (
        <>
          <p className="muted">
            This is a spoken interview, so your browser will ask to use the microphone — that's the only
            thing it's used for, and nothing is recorded or uploaded. Click below, then <strong>say your
            name</strong> out loud.
          </p>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn" onClick={m.beginMicCheck}>
              Enable microphone
            </button>
            <span className={`level ${m.hearing ? "active" : ""}`} aria-hidden>
              <span /><span /><span /><span />
            </span>
          </div>
          {m.micCheckTranscript && (
            <p style={{ marginTop: 16 }}>
              Heard: <strong>“{m.micCheckTranscript}”</strong>
            </p>
          )}
          <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <button className="btn" onClick={m.confirmMicCheck} disabled={!started}>
              Sounds right — continue
            </button>
            <button className="btn secondary" onClick={m.switchToTextMode}>
              Use text mode instead
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            {m.degradeReason === "unsupported"
              ? "This browser doesn't support voice input — the interview runs in text mode. Questions are still spoken aloud and always captioned."
              : "Microphone unavailable — continuing in text mode. Questions are still spoken aloud and always captioned."}
          </p>
          <button className="btn" onClick={m.confirmMicCheck}>
            Continue in text mode
          </button>
        </>
      )}
    </section>
  );
}

function Preroll({ m }: { m: M }) {
  return (
    <section className="card">
      <h2>Before we start</h2>
      <p>
        Priya will ask <strong>5 questions — about 10 minutes</strong>. Answer out loud, take your time.
      </p>
      <p>
        <strong>Pausing for ~2 seconds ends your answer</strong> — like handing the turn back to the
        interviewer. You can also press <kbd>Enter</kbd> or the “I'm done answering” button.
      </p>
      <button className="btn" onClick={m.startInterview}>
        Start the interview
      </button>
    </section>
  );
}

function Live({ m, textDraft, setTextDraft }: { m: M; textDraft: string; setTextDraft: (s: string) => void }) {
  const submitText = () => {
    if (!textDraft.trim()) return;
    m.submitTextAnswer(textDraft.trim());
    setTextDraft("");
  };

  return (
    <section>
      {/* Captions: the interviewer's words always render (a11y + noisy rooms). */}
      <div className="card" aria-live="polite" style={{ minHeight: 96 }}>
        {m.phase === "thinking" ? (
          <p className="muted" style={{ margin: 0 }}>
            Priya is thinking…
          </p>
        ) : (
          <p style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "1.15rem" }}>{m.caption}</p>
        )}
      </div>

      {m.phase === "listening" && !m.textMode && (
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span className={`level ${m.hearing ? "active" : ""}`} aria-hidden>
            <span /><span /><span /><span />
          </span>
          <span className="small" style={{ color: "var(--live)" }}>
            Your turn — speaking
          </span>
          <button className="btn secondary" onClick={m.endAnswerNow}>
            I'm done answering (Enter)
          </button>
        </div>
      )}

      {m.phase === "listening" && !m.textMode && m.lastSentence && (
        <p className="small muted" style={{ marginTop: 12 }}>
          …{m.lastSentence}
        </p>
      )}

      {m.phase === "listening" && m.textMode && (
        <div style={{ marginTop: 20 }} className="field">
          <label htmlFor="answer">Type your answer</label>
          <textarea
            id="answer"
            rows={5}
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitText();
            }}
          />
          <div>
            <button className="btn" onClick={submitText} disabled={!textDraft.trim()}>
              Submit answer
            </button>
          </div>
        </div>
      )}

      {m.latencies.length > 0 && (
        <p className="small muted mono-num" style={{ marginTop: 24 }}>
          Interviewer response latency: last {m.latencies[m.latencies.length - 1]} ms · avg {m.avgLatencyMs} ms
          (target ≤ 2000 ms; streaming lands next)
        </p>
      )}
    </section>
  );
}

function Summary({ m }: { m: M }) {
  const s = m.session;
  if (!s) return null;

  const downloadTrace = () => {
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `interview-session-${s._id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section>
      <h2>Round complete</h2>
      <p className="muted">
        Evidence-based scoring arrives with the next build. Today you get the full transcript, your
        delivery numbers, and the response-latency measurements.
      </p>

      {s.deliveryMetrics && (
        <div className="card" style={{ margin: "16px 0" }}>
          <table className="plain mono-num" aria-label="Delivery metrics">
            <tbody>
              <tr>
                <td>Speaking pace</td>
                <td>{s.deliveryMetrics.wpm > 0 ? `${s.deliveryMetrics.wpm} words/min` : "not enough voice signal"}</td>
              </tr>
              <tr>
                <td>Lexical fillers (“basically”, “like”…)</td>
                <td>{s.deliveryMetrics.fillerCount}</td>
              </tr>
              <tr>
                <td>Long pauses (&gt;2s)</td>
                <td>{s.deliveryMetrics.hesitationCount}</td>
              </tr>
              <tr>
                <td>Longest pause</td>
                <td>{(s.deliveryMetrics.longestPauseMs / 1000).toFixed(1)}s</td>
              </tr>
              {s.latency.avgMs !== null && (
                <tr>
                  <td>Avg interviewer latency</td>
                  <td>{s.latency.avgMs} ms</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Transcript on a vertical turn timeline — the spine the replay page
          (M5) adds its scrubber to. Same route, same layout skeleton. */}
      <div style={{ display: "grid", gap: 12, margin: "20px 0" }}>
        {s.turns.map((t, i) => (
          <div key={i} className="card" style={{ borderLeft: `3px solid ${t.speaker === "interviewer" ? "var(--accent)" : "var(--border)"}` }}>
            <div className="small muted">
              {t.speaker === "interviewer" ? "Priya" : "You"} ·{" "}
              <span className="mono-num">{new Date(t.tStart).toLocaleTimeString()}</span>
            </div>
            <p style={{ margin: "4px 0 0" }}>{t.text}</p>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <a className="btn" href="/">
          Practice again
        </a>
        <button className="btn secondary" onClick={downloadTrace}>
          Download session JSON
        </button>
      </div>
    </section>
  );
}
