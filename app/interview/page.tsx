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
import { sttCapabilities } from "@/lib/stt";
import { micHelp } from "@/lib/mic-help";
import { codingQuestionFor, type CodingQuestion } from "@/lib/fixtures/technical-questions";
import type { CodeLanguage, RolePreset } from "@/lib/types";
import { ReadinessReportCard } from "@/components/report/ReadinessReport";
import { isRolePreset, supportsTechnicalRound } from "@/lib/interview/roles";
import type { InterviewView } from "@/lib/interview/types";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

// The interviewer's spoken words are the humane moment — they render in the
// display serif, large, centered (see .caption in globals.css). Everything
// else stays quiet UI sans.
const ENGINE_LABEL: Record<VoiceEngine, string> = {
  cloud: "Cloud voice",
  chatterbox: "Studio voice",
  elevenlabs: "Cloud voice",
  kokoro: "On-device voice",
  system: "Basic voice",
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
  const requestedRole = params.get("role");
  const role: RolePreset = isRolePreset(requestedRole) ? requestedRole : "sde";
  // A behavioural-only role has no technical round to run.
  const round = params.get("round") === "technical" && supportsTechnicalRound(role) ? "technical" : "hr";
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
      if (!inProgress) return;
      e.preventDefault();
      // Legacy browsers only honour a set returnValue.
      e.returnValue = "";
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
    m.discardResume();
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
          {m.view && live ? (
            <CoverageStrip view={m.view} coding={m.codingTurn} />
          ) : inQuestions ? (
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
          {m.error && !m.retryable ? (
            <>
              <h2>The interviewer is out of capacity</h2>
              <p className="muted">{m.error}</p>
            </>
          ) : m.error ? (
            <>
              <h2>One moment</h2>
              <p className="muted">{m.error}</p>
              <button className="btn" onClick={m.retryConnection}>
                Try again
              </button>
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
            This is a spoken interview, so your browser will ask to use the microphone. Your voice is
            transcribed as you speak and never stored — only the words reach the interviewer. Click
            below, then <strong>say your name</strong> out loud.
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
          <p className="muted">{micHelp(m.degradeReason, { cloudStt: Boolean(sttCapabilities()?.cloud) })}</p>
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
      <h2>{m.resuming ? "Welcome back" : "Before we start"}</h2>
      {m.resuming && (
        <p className="card tinted" role="status">
          This tab still holds your unfinished round — Start picks it up where you left off, with the last question spoken again. Nothing you already answered is asked twice.
        </p>
      )}
      <p>
        A real conversation with {first} — <strong>about 10 minutes</strong>. They follow what you
        say, so answers change where it goes, and you can ask them questions too.
        {m.roundType === "technical" && <> There's <strong>hands-on coding</strong> in this one — an editor opens when it's time.</>}{" "}
        Answer out loud, take your time.
      </p>
      <p>
        <strong>A short pause ends your answer</strong> — like handing the turn back to the interviewer.
        Trailing off mid-sentence (“and… um…”) buys you longer, and saying “that's it” hands over straight
        away. You can also press <kbd>Enter</kbd> or the “I'm done answering” button.
      </p>
      {m.bargeIn ? (
        <p>
          This is a real conversation: <strong>you can interrupt {first} any time — just start talking</strong>{" "}
          and they'll stop and listen. Your mic is open from the moment they begin, so an answer that
          starts early is never cut off at the front.
        </p>
      ) : (
        <p>
          {first} will finish each question before your mic opens — you asked for it that way.
        </p>
      )}
      {/* The opt-out lives HERE, next to the explanation of what it does, and
          defaults to on: interrupting is how interviews work. Speakers are fine
          (their voice is filtered out of your answer); this is for a noisy room
          or a shared desk, where someone else's talking is the real risk. */}
      <label className="toggle-card">
        <input type="checkbox" checked={m.bargeIn} onChange={(e) => m.setBargeIn(e.target.checked)} />
        <span>
          <span className="toggle-title">Let me interrupt {first} mid-question</span>
          <span className="choice-desc small muted">
            On by default. Turn it off in a noisy room or on a shared desk, where someone else talking is
            the thing most likely to cut a question short.
          </span>
        </span>
      </label>
      {/* The on-device voice is a one-time download. Starting before it lands
          meant the greeting came out of the robotic system voice and the
          interviewer changed voice a minute in — so the button waits, and
          says why. */}
      {!m.voiceWarmup.ready && (
        <p className="small muted" role="status" aria-live="polite">
          Preparing {first}'s voice — a one-time download, kept by your browser
          {m.voiceWarmup.progress !== null ? ` (${m.voiceWarmup.progress}%)` : ""}…
        </p>
      )}
      <button className="btn" onClick={m.startInterview} disabled={!m.voiceWarmup.ready}>
        {m.voiceWarmup.ready ? "Start the interview" : "Preparing the voice…"}
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
  // The editor loads from a CDN at runtime; if it has not mounted within a
  // few seconds (offline, blocked CDN), a plain textarea takes over so the
  // coding answer is never impossible to give.
  const [editorReady, setEditorReady] = useState(false);
  const [editorTimedOut, setEditorTimedOut] = useState(false);
  useEffect(() => {
    if (!m.codingTurn) return;
    setEditorReady(false);
    setEditorTimedOut(false);
    const id = setTimeout(() => setEditorTimedOut(true), 7000);
    return () => clearTimeout(id);
  }, [m.codingTurn]);
  const useFallbackEditor = editorTimedOut && !editorReady;

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
            {useFallbackEditor ? (
              <textarea
                aria-label="Code editor"
                value={codeDraft}
                onChange={(e) => setCodeDraft(e.target.value)}
                spellCheck={false}
                style={{ width: "100%", height: 320, fontFamily: "var(--font-mono), monospace", fontSize: 13, padding: 12 }}
              />
            ) : (
              <MonacoEditor
                height="320px"
                language={codingQ.language}
                theme="vs"
                value={codeDraft}
                onChange={(v) => setCodeDraft(v ?? "")}
                onMount={() => setEditorReady(true)}
                loading={<p className="small muted">Loading the editor…</p>}
                options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 12 } }}
              />
            )}
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

      {/* One visual per state: speaking = a quiet, truthful hint. */}
      {m.phase === "speaking" && !m.textMode && (
        <p className="small muted room-hint">
          {m.bargeIn ? "mic is live — jump in anytime" : `${first} is speaking — your turn comes right after`}
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
          Response time: last {m.latencies[m.latencies.length - 1]} ms
          {m.instantFlags[m.latencies.length - 1] && " · ⚡ instant"} · avg {m.avgLatencyMs} ms
          {m.fallbackFlags[m.latencies.length - 1] && " · basic voice"}
        </p>
      )}
    </section>
  );
}

/** Quiet progress toward coverage: one bar per competency the plan must assess. */
function CoverageStrip({ view, coding }: { view: InterviewView; coding: boolean }) {
  const current = view.competencies.find((c) => c.id === view.current);
  return (
    <span className="coverage-strip" role="img" aria-label={`Interview coverage ${Math.round(view.progress * 100)} percent`}>
      {view.competencies.map((c) => (
        <span key={c.id} title={`${c.label}: ${c.status.replace("-", " ")}`} className={`cov ${c.status}${c.id === view.current ? " now" : ""}`}>
          <i style={{ width: `${Math.round(Math.min(1, c.coverage / 0.6) * 100)}%` }} />
        </span>
      ))}
      <span className="small">
        {current ? current.label : "Coverage"}
        {coding ? " · coding" : ""}
      </span>
    </span>
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
      {s.readiness && <ReadinessReportCard report={s.readiness} />}

      <ScoreVerdict entries={entries} summary={s.overall.summary} scoring={s.scoring} />

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
