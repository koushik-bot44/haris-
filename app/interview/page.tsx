"use client";

import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInterviewMachine } from "@/hooks/useInterviewMachine";
import { VoiceOrb } from "@/components/VoiceOrb";
import { ScoreVerdict } from "@/components/report/ScoreVerdict";
import { DeliveryRow } from "@/components/report/DeliveryRow";
import { QuestionCard } from "@/components/report/QuestionCard";
import { TurnTimeline } from "@/components/report/TurnTimeline";
import { getVoiceEngine, lastEngineUsed, type VoiceEngine } from "@/lib/tts";
import { codingQuestionFor, type CodingQuestion } from "@/lib/fixtures/technical-questions";
import type { CodeLanguage, RolePreset } from "@/lib/types";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

// The interviewer's spoken words are the humane moment — they render in the
// display serif, large, centered (see .caption in globals.css). Everything
// else stays quiet UI sans.
const ENGINE_LABEL: Record<VoiceEngine, string> = {
  chatterbox: "Studio voice",
  elevenlabs: "Cloud voice",
  kokoro: "On-device voice",
  system: "System voice",
};

const CODE_LANGS: CodeLanguage[] = ["java", "python", "cpp", "javascript", "c"];
const LANG_LABEL: Record<CodeLanguage, string> = {
  java: "Java",
  python: "Python",
  cpp: "C++",
  javascript: "JavaScript",
  c: "C",
};

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
  // Language picked on the setup screen — the problem stays per-role, but the
  // starter + Monaco mode follow the choice (junk/missing storage → java).
  const [codeLang] = useState<CodeLanguage>(() => {
    try {
      const v = window.sessionStorage.getItem("pds_code_lang");
      return CODE_LANGS.includes(v as CodeLanguage) ? (v as CodeLanguage) : "java";
    } catch {
      return "java";
    }
  });
  const m = useInterviewMachine(name, role, round, resume);
  // The machine owns this: it seeds the pick from the same value the server
  // uses, so the editor's starter always matches the problem that was spoken.
  // Computing it here independently would drift the moment the pool grew.
  const codingQ = m.codingQuestion;
  const [textDraft, setTextDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  // Engine label is read after mount — localStorage is a client-only source.
  // Re-read on every phase change so the chip reflects the engine that
  // ACTUALLY spoke (fallbacks show truthfully), not just the stored choice.
  const [engine, setEngine] = useState<VoiceEngine | null>(null);
  useEffect(() => {
    setEngine(lastEngineUsed() ?? getVoiceEngine());
  }, [m.phase]);

  // Fresh starter code whenever a coding turn begins — language-matched.
  useEffect(() => {
    if (m.codingTurn) setCodeDraft(codingQ.starter);
  }, [m.codingTurn, codingQ.starter]);

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

  const live = m.phase === "thinking" || m.phase === "speaking" || m.phase === "listening";
  const roundLabel = round === "technical" ? "Technical round" : "HR round";

  const inQuestions = m.questionIndex > 0 && m.phase !== "done";

  return (
    <main className="wrap">
      {/* Minimal room chrome — the global header stays out of the room. */}
      <header className="room-bar">
        <div className="room-bar-meta mono-num">
          {inQuestions ? (
            <>
              <span className="qmeter" aria-hidden>
                {[1, 2, 3, 4, 5].map((n) => (
                  <i key={n} className={n <= m.questionIndex ? "on" : ""} />
                ))}
              </span>
              <span>
                Topic {m.questionIndex}
                {m.codingTurn && <span className="muted"> · coding</span>}
              </span>
            </>
          ) : (
            <span>{roundLabel}</span>
          )}
        </div>
        <div className="room-bar-actions">
          <span className={m.textMode ? "chip" : "chip on"}>
            <span className="dot" />
            {m.textMode ? "Text mode" : engine ? ENGINE_LABEL[engine] : "Voice"}
          </span>
          <button className="btn quiet" onClick={leave}>
            Leave
          </button>
        </div>
      </header>

      {/* The stage: the orb is the only living color, centered with room to
          breathe; the persona identity sits quietly beneath it. */}
      {live && !m.codingTurn && (
        <div className="orb-stage">
          <VoiceOrb size={240} />
          <div className="persona-id">
            <div className="persona-name">{m.persona.name}</div>
            <div className="persona-title">{m.persona.title}</div>
          </div>
        </div>
      )}

      {m.phase === "micCheck" && <MicCheck m={m} />}
      {m.phase === "preroll" && <Preroll m={m} />}
      {live && (
        <Live
          m={m}
          codingQ={codingQ}
          textDraft={textDraft}
          setTextDraft={setTextDraft}
          codeDraft={codeDraft}
          setCodeDraft={setCodeDraft}
        />
      )}
      {/* Quota/error message from the machine — friendly text, and no
          "Try again" (retrying a spent quota only burns the user's time). */}
      {m.error && m.phase !== "connectionLost" && m.phase !== "done" && (
        <div className="card tinted room-status" role="status">
          <p className="small">{m.error}</p>
        </div>
      )}
      {m.phase === "connectionLost" && (
        <section className="card panel-enter" role="alert">
          {m.error ? (
            <>
              <h2>The interviewer is out of capacity</h2>
              <p className="muted">{m.error}</p>
            </>
          ) : (
            <>
              <h2>The interviewer lost connection</h2>
              <p className="muted">Your answers are safe. You can try again — the round continues where it left off.</p>
              <button className="btn" onClick={m.retryConnection}>
                Try again
              </button>
            </>
          )}
        </section>
      )}
      {m.phase === "done" && <Summary m={m} />}

      {/* Screen-reader phase announcements — phase swaps unmount the focused
          button, so an explicit live region carries the transition. */}
      <div aria-live="polite" className="sr-only">
        {m.phase === "preroll" && "Mic check passed. Interview instructions shown."}
        {m.phase === "listening" && "Your turn to answer."}
        {m.phase === "thinking" && "Answer recorded."}
        {m.phase === "done" && "Round complete. Your results are shown."}
      </div>

      {m.phase !== "done" && (
        <p className="small muted room-note">
          Keep this tab active during the interview — browsers pause speech in background tabs.
        </p>
      )}
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
    <section className="card panel-enter">
      <h2>Quick mic check</h2>
      {!m.textMode ? (
        <>
          <p className="muted">
            This is a spoken interview, so your browser will ask to use the microphone — that's the only
            thing it's used for, and nothing is recorded or uploaded. Click below, then <strong>say your
            name</strong> out loud.
          </p>
          <div className="mic-row">
            <button className="btn" onClick={m.beginMicCheck}>
              Enable microphone
            </button>
            <span className={`level ${m.hearing ? "active" : ""}`} aria-hidden>
              <span /><span /><span /><span />
            </span>
          </div>
          {m.micCheckTranscript && (
            <p className="heard">
              <span className="small muted">Heard</span>{" "}
              <span className="display heard-quote">“{m.micCheckTranscript}”</span>
            </p>
          )}
          <div className="mic-row">
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
          <div className="mic-row">
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
            <p className={`small whisper-status${whisper === "ready" ? " ok" : ""}`}>
              On-device speech engine:{" "}
              {whisper === "loading" && "downloading… (~40MB, one time)"}
              {whisper === "ready" && "ready ✓ — hit “Try microphone again”"}
              {whisper === "failed" && "failed to load on this machine"}
            </p>
          )}
          {m.degradeReason && (
            <p className="small muted mic-diag">
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
    <section className="card panel-enter">
      <h2>Before we start</h2>
      <p>
        A real conversation with {first} — <strong>about 10 minutes</strong>. They follow what you
        say, so answers change where it goes, and you can ask them questions too.
        {m.persona.initials === "AR" && <> There's <strong>hands-on coding</strong> in this one — an editor opens when it's time.</>}{" "}
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
  codingQ,
  textDraft,
  setTextDraft,
  codeDraft,
  setCodeDraft,
}: {
  m: M;
  codingQ: CodingQuestion;
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
  const first = m.persona.name.split(" ")[0];

  return (
    <section className="room-live">
      {/* Captions: the interviewer's words always render (a11y + noisy rooms).
          They are the star of the screen — display serif, large, centered. */}
      <div aria-live="polite" className="caption-shell">
        {m.phase === "thinking" && !m.caption ? (
          <span className="chip">{first} is thinking…</span>
        ) : (
          // Display-first streaming: the reply types out here DURING thinking,
          // the voice joins from the first finished sentence.
          <p className="caption">{m.caption}</p>
        )}
      </div>

      {/* Coding turn: the editor IS the answer surface (technical round Q3). */}
      {m.codingTurn && m.phase === "listening" && (
        <div className="code-answer panel-enter">
          <div className="card code-pane">
            <div className="code-pane-head">
              <span className="code-pane-title">Hands-on question</span>
              <span className="chip">{LANG_LABEL[codingQ.language]}</span>
            </div>
            <MonacoEditor
              height="320px"
              language={codingQ.language}
              theme="vs"
              value={codeDraft}
              onChange={(v) => setCodeDraft(v ?? "")}
              options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 12 } }}
            />
          </div>
          <div className="code-actions">
            <button className="btn" onClick={submitCode} disabled={!codeDraft.trim()}>
              Submit code
            </button>
            <span className="small muted">
              Talk through your approach in comments — the interviewer reads them too.
            </span>
          </div>
        </div>
      )}

      {/* One visual per state: speaking = a quiet open-door hint. */}
      {m.phase === "speaking" && !m.textMode && (
        <p className="small muted room-hint">
          mic is live — jump in anytime
        </p>
      )}

      {/* Listening = level bars + the one recording-red chip. */}
      {m.phase === "listening" && !m.textMode && !m.codingTurn && (
        <div className="turn-cue panel-enter">
          <div className="turn-cue-row">
            <span className={`level ${m.hearing ? "active" : ""}`} aria-hidden>
              <span /><span /><span /><span />
            </span>
            <span className="chip live">
              <span className="dot" />
              Your turn — speak
            </span>
          </div>
          <div className="turn-actions">
            <button className="btn secondary" data-end-answer="true" onClick={m.endAnswerNow}>
              I'm done answering
            </button>
            <span className="small muted">
              or press <kbd>Enter</kbd>
            </span>
          </div>
        </div>
      )}

      {/* Low-emphasis proof of hearing — the last finalized sentence. */}
      {m.phase === "listening" && !m.textMode && m.lastSentence && (
        <p className="small muted last-sentence">
          …{m.lastSentence}
        </p>
      )}

      {/* Text mode: first-class, same identity — the answer just arrives typed. */}
      {m.phase === "listening" && m.textMode && !m.codingTurn && (
        <div className="field answer-form panel-enter">
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
          <div className="answer-actions">
            <button className="btn" onClick={submitText} disabled={!textDraft.trim()}>
              Submit answer
            </button>
            <span className="small muted">
              <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd>
            </span>
            <button className="btn quiet" onClick={m.retryVoice}>
              Try voice again
            </button>
          </div>
        </div>
      )}

      {m.latencies.length > 0 && (
        <p className="small muted mono-num latency-note">
          Interviewer response latency: last {m.latencies[m.latencies.length - 1]} ms
          {m.instantFlags[m.latencies.length - 1] && " · ⚡ instant"} · avg {m.avgLatencyMs} ms
          (target ≤ 2000 ms; streaming lands next)
        </p>
      )}
    </section>
  );
}

function Summary({ m }: { m: M }) {
  const s = m.session;
  if (!s) return null;
  // Live scores may trail the saved session (background stragglers) — prefer the richer set.
  const entries = m.scores.length >= s.perQuestionScores.length ? m.scores : s.perQuestionScores;

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
    <section className="panel-enter">
      <h2>Round complete</h2>

      {/* FIRST: the verdict — score + coach summary. ScoreVerdict raises its
          own card; wrapping it in another one double-stacks the chrome. */}
      <ScoreVerdict entries={entries} summary={s.overall.summary} />

      {!m.sessionPersisted && (
        <div className="card tinted notice" role="status">
          <div className="notice-title">Couldn't save</div>
          <div className="small">
            This device can't store sessions (private browsing?) — download the JSON below to keep this
            round; it disappears when the tab closes.
          </div>
        </div>
      )}

      {/* SECOND: delivery — one quiet row of numbers. */}
      <DeliveryRow session={s} />

      {/* THIRD: per-question cards — strongest criterion first, evidence as
          pull-quotes from the candidate's own (verified) words. */}
      {entries.length > 0 && (
        <div className="summary-questions">
          {entries.map((e) => (
            <QuestionCard key={e.questionId} entry={e} />
          ))}
        </div>
      )}

      {/* LAST: transcript on the shared turn timeline — the same spine the
          replay page (/report/[id]) adds its scrubber to. */}
      <div className="summary-timeline">
        <TurnTimeline session={s} />
      </div>

      <div className="summary-actions">
        {m.sessionPersisted && (
          <Link className="btn" href={`/report/${s._id}`}>
            View full report →
          </Link>
        )}
        <button className={m.sessionPersisted ? "btn secondary" : "btn"} onClick={downloadTrace}>
          Download session JSON
        </button>
        <a className="btn quiet" href="/">
          Practice again
        </a>
      </div>
    </section>
  );
}
