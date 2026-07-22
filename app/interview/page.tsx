"use client";

import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useInterviewMachine } from "@/hooks/useInterviewMachine";
import { VoiceOrb } from "@/components/VoiceOrb";
import type { RolePreset } from "@/lib/types";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

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
  const round = params.get("round") === "technical" ? "technical" : "hr";
  const [resume] = useState(() => {
    try {
      return window.sessionStorage.getItem("pds_resume") ?? undefined;
    } catch {
      return undefined;
    }
  });

  const m = useInterviewMachine(name, role, round, resume);
  const [textDraft, setTextDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");

  // Fresh starter code whenever a coding turn begins.
  useEffect(() => {
    if (m.codingTurn) setCodeDraft(m.codingQuestion.starter);
  }, [m.codingTurn, m.codingQuestion.starter]);

  // Leaving mid-interview loses the answer in progress — warn (UX spec).
  useEffect(() => {
    const inProgress = !["done", "micCheck", "preroll"].includes(m.phase);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (inProgress) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [m.phase]);

  // Keyboard: Enter ends the current answer (voice mode). Keyboard-first per
  // a11y floor — but never steal Enter from another focused control (a user
  // tabbed onto "Leave" pressing Enter means Leave, not "answer done").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || m.phase !== "listening" || m.textMode) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        el.closest("button, a, input, select, textarea") &&
        !el.dataset.endAnswer
      ) {
        return;
      }
      e.preventDefault();
      m.endAnswerNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [m]);

  // Seed the textarea with whatever was transcribed before STT degraded
  // mid-answer — 45 seconds of speech must not vanish into an empty box.
  useEffect(() => {
    if (m.degradePrefill) setTextDraft((prev) => (prev ? prev : m.degradePrefill));
  }, [m.degradePrefill]);

  const leave = () => {
    m.cleanup();
    router.push("/");
  };

  return (
    <main className="wrap">
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 12 }}>
        <div className="small muted mono-num">
          {m.questionIndex > 0 && m.phase !== "done" ? `Question ${m.questionIndex} of 5` : ""}
        </div>
        <button className="btn secondary" onClick={leave}>
          Leave
        </button>
      </header>

      {/* The voice orb — center stage while the conversation is live. Glows and
          morphs from real audio: your mic while you speak, her playback while
          she does. */}
      {["thinking", "speaking", "listening"].includes(m.phase) && !m.codingTurn && (
        <div style={{ display: "flex", justifyContent: "center", margin: "4px 0 8px" }}>
          <VoiceOrb size={250} />
        </div>
      )}

      {m.phase === "micCheck" && <MicCheck m={m} />}
      {m.phase === "preroll" && <Preroll m={m} />}
      {(m.phase === "thinking" || m.phase === "speaking" || m.phase === "listening") && (
        <Live
          m={m}
          textDraft={textDraft}
          setTextDraft={setTextDraft}
          codeDraft={codeDraft}
          setCodeDraft={setCodeDraft}
        />
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

      {/* Screen-reader phase announcements — phase swaps unmount the focused
          button, so an explicit live region carries the transition. */}
      <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>
        {m.phase === "preroll" && "Mic check passed. Interview instructions shown."}
        {m.phase === "listening" && "Your turn to answer."}
        {m.phase === "thinking" && "Answer recorded."}
        {m.phase === "done" && "Round complete. Your results are shown."}
      </div>

      <p className="small muted" style={{ marginTop: 40 }}>
        Keep this tab active during the interview — browsers pause speech in background tabs.
      </p>
    </main>
  );
}

type M = ReturnType<typeof useInterviewMachine>;

function micHelp(reason: string | null): string {
  switch (reason) {
    case "unsupported":
      return "This browser has no built-in speech recognition — switching to the on-device engine (a one-time ~40MB download). Voice will work here once it's ready.";
    case "not-allowed":
    case "service-not-allowed":
      return "The microphone is blocked. Click the lock (or camera) icon in the address bar → Microphone → Allow, then try again.";
    case "network":
      return "Your browser can't reach Google's speech service — Brave, Arc, plain Chromium builds, and some VPNs all block it (your internet is fine). Two fixes: open this page in real Google Chrome, or wait for the on-device speech engine below — a one-time ~40MB download that works in ANY browser, even offline.";
    case "whisper_loading":
      return "The on-device speech engine is still downloading (~40MB, one time). Try the microphone again when it says ready — or continue in text mode meanwhile.";
    case "whisper_failed":
      return "The on-device speech engine failed to load on this machine. Text mode works everywhere; real Google Chrome enables the online engine.";
    default:
      return "Microphone unavailable right now. You can retry, or continue in text mode — questions are still spoken aloud and always captioned.";
  }
}

function useWhisperBadge(active: boolean): string {
  const [status, setStatus] = useState("off");
  useEffect(() => {
    if (!active) return;
    const id = setInterval(async () => {
      const { whisperStatus } = await import("@/lib/stt-whisper");
      setStatus(whisperStatus());
    }, 800);
    return () => clearInterval(id);
  }, [active]);
  return status;
}

function MicCheck({ m }: { m: M }) {
  const started = m.micCheckTranscript.length > 0 || m.hearing;
  const whisper = useWhisperBadge(m.textMode);
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
          <p className="muted">{micHelp(m.degradeReason)}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button
              className="btn"
              onClick={() => {
                // One click = fresh mic attempt, permission prompt included.
                m.retryVoice();
                m.beginMicCheck();
              }}
            >
              Try microphone again
            </button>
            <button className="btn secondary" onClick={m.confirmMicCheck}>
              Continue in text mode
            </button>
          </div>
          {whisper !== "off" && (
            <p className="small" style={{ marginTop: 10, color: whisper === "ready" ? "var(--ok)" : "var(--muted)" }}>
              On-device speech engine:{" "}
              {whisper === "loading" && "downloading… (~40MB, one time)"}
              {whisper === "ready" && "ready ✓ — hit “Try microphone again”"}
              {whisper === "failed" && "failed to load on this machine"}
            </p>
          )}
          {m.degradeReason && (
            <p className="small muted" style={{ marginTop: 10 }}>
              diagnostic code: <code>{m.degradeReason}</code>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Preroll({ m }: { m: M }) {
  const first = m.persona.name.split(" ")[0];
  return (
    <section className="card">
      <h2>Before we start</h2>
      <p>
        {first} will ask <strong>5 questions — about 10 minutes</strong>.
        {m.persona.initials === "AR" && <> One of them is <strong>hands-on coding</strong> — an editor opens when it's time.</>}{" "}
        Answer out loud, take your time.
      </p>
      <p>
        <strong>Pausing for ~2 seconds ends your answer</strong> — like handing the turn back to the
        interviewer. You can also press <kbd>Enter</kbd> or the “I'm done answering” button.
      </p>
      <p>
        This is a real conversation: <strong>you can interrupt {first} any time — just start talking</strong>{" "}
        and they'll stop and listen. Headphones make this seamless (without them, their voice through
        your speakers can confuse the mic).
      </p>
      <button className="btn" onClick={m.startInterview}>
        Start the interview
      </button>
    </section>
  );
}

function Live({
  m,
  textDraft,
  setTextDraft,
  codeDraft,
  setCodeDraft,
}: {
  m: M;
  textDraft: string;
  setTextDraft: (s: string) => void;
  codeDraft: string;
  setCodeDraft: (s: string) => void;
}) {
  const submitText = () => {
    if (!textDraft.trim()) return;
    m.submitTextAnswer(textDraft.trim());
    setTextDraft("");
  };
  const submitCode = () => {
    if (!codeDraft.trim()) return;
    m.submitTextAnswer(codeDraft);
    setCodeDraft("");
  };

  return (
    <section>
      {/* Captions: the interviewer's words always render (a11y + noisy rooms). */}
      <div className="card" aria-live="polite" style={{ minHeight: 96 }}>
        {m.phase === "thinking" ? (
          <p className="muted" style={{ margin: 0 }}>
            {m.persona.name.split(" ")[0]} is thinking…
          </p>
        ) : (
          <p style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "1.15rem" }}>{m.caption}</p>
        )}
      </div>

      {/* Coding turn: the editor IS the answer surface (technical round Q3). */}
      {m.codingTurn && m.phase === "listening" && (
        <div style={{ marginTop: 20, display: "grid", gap: 12 }}>
          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
            <MonacoEditor
              height="320px"
              language={m.codingQuestion.language}
              theme="light"
              value={codeDraft}
              onChange={(v) => setCodeDraft(v ?? "")}
              options={{ minimap: { enabled: false }, fontSize: 14, scrollBeyondLastLine: false }}
            />
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn" onClick={submitCode} disabled={!codeDraft.trim()}>
              Submit code
            </button>
            <span className="small muted">
              Talk through your approach in comments — the interviewer reads them too.
            </span>
          </div>
        </div>
      )}

      {m.phase === "speaking" && !m.textMode && (
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span className={`level ${m.hearing ? "active" : ""}`} aria-hidden>
            <span /><span /><span /><span />
          </span>
          <span className="small muted">mic is live — jump in anytime</span>
        </div>
      )}

      {m.phase === "listening" && !m.textMode && !m.codingTurn && (
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span className={`level ${m.hearing ? "active" : ""}`} aria-hidden>
            <span /><span /><span /><span />
          </span>
          <span style={{ color: "var(--live)", fontSize: "1.05rem", fontWeight: 600 }}>
            Your turn — speaking
          </span>
          <button className="btn secondary" data-end-answer="true" onClick={m.endAnswerNow}>
            I'm done answering (Enter)
          </button>
        </div>
      )}

      {m.phase === "listening" && !m.textMode && m.lastSentence && (
        <p className="small muted" style={{ marginTop: 12 }}>
          …{m.lastSentence}
        </p>
      )}

      {m.phase === "listening" && m.textMode && !m.codingTurn && (
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
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn" onClick={submitText} disabled={!textDraft.trim()}>
              Submit answer
            </button>
            <button className="btn secondary" onClick={m.retryVoice}>
              Try voice again
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

const CRITERIA_ORDER = ["relevance", "structure", "depth", "communication"] as const;
const CRITERION_LABEL: Record<string, string> = {
  relevance: "Relevance",
  structure: "Structure",
  depth: "Depth",
  communication: "Communication",
};

function QuestionBlock({ entry }: { entry: NonNullable<M["session"]>["perQuestionScores"][number] }) {
  // Coach ordering: strongest criterion first, weakest last — never a list of failures.
  const ordered = [...CRITERIA_ORDER].sort((a, b) => entry.scores[b] - entry.scores[a]);
  const avg = (entry.scores.relevance + entry.scores.structure + entry.scores.depth + entry.scores.communication) / 4;
  return (
    <div className="card" style={{ borderLeft: "3px solid var(--accent)" }}>
      <div className="small muted">Question {entry.questionId} · {avg.toFixed(1)}/5</div>
      <p style={{ margin: "4px 0 10px", fontFamily: "var(--font-display)" }}>{entry.question}</p>
      <div style={{ display: "grid", gap: 10 }}>
        {ordered.map((c) => (
          <div key={c}>
            <div className="small mono-num">
              <strong>{CRITERION_LABEL[c]}</strong> {entry.scores[c]}/5
            </div>
            {entry.evidence[c] && (
              <blockquote
                style={{ margin: "4px 0", padding: "6px 12px", borderLeft: "2px solid var(--border)", fontFamily: "var(--font-display)", fontSize: "0.98rem" }}
              >
                “{entry.evidence[c]}” <span className="small muted">— you</span>
              </blockquote>
            )}
            {entry.tips[c] && <div className="small muted">{entry.tips[c]}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Summary({ m }: { m: M }) {
  const s = m.session;
  if (!s) return null;
  // Live scores may trail the saved session (background stragglers) — prefer the richer set.
  const entries = m.scores.length >= s.perQuestionScores.length ? m.scores : s.perQuestionScores;
  const avg =
    entries.length > 0
      ? entries.reduce((a, e) => a + (e.scores.relevance + e.scores.structure + e.scores.depth + e.scores.communication) / 4, 0) / entries.length
      : null;

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

      {/* FIRST: the verdict — score + one strength + one priority fix, large. */}
      {avg !== null ? (
        <div className="card" style={{ margin: "12px 0", borderLeft: "3px solid var(--accent)" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "2.4rem", lineHeight: 1 }} className="mono-num">
            {avg.toFixed(1)}<span className="muted" style={{ fontSize: "1.2rem" }}>/5</span>
          </div>
          <p style={{ margin: "8px 0 0" }}>{s.overall.summary}</p>
        </div>
      ) : (
        <p className="muted">
          Answers were too short to score this round — aim for 30+ seconds per answer. Transcript and
          delivery numbers below.
        </p>
      )}

      {!m.sessionPersisted && (
        <div className="card" role="status" style={{ borderLeft: "3px solid var(--live)", margin: "12px 0" }}>
          This device can't store sessions (private browsing?) — <strong>download the JSON below</strong> to
          keep this round; it disappears when the tab closes.
        </div>
      )}

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
                <td>Hesitations (pauses &gt;1.1s)</td>
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

      {/* THIRD: per-question blocks — strongest criterion first, evidence as
          pull-quotes from the candidate's own (verified) words. */}
      {entries.length > 0 && (
        <div style={{ display: "grid", gap: 12, margin: "20px 0" }}>
          {entries.map((e) => (
            <QuestionBlock key={e.questionId} entry={e} />
          ))}
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
