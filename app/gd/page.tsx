"use client";

import { Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GD_CAP_MS, useGdMachine } from "@/hooks/useGdMachine";
import { VoiceOrb } from "@/components/VoiceOrb";
import { GD_TOPICS } from "@/lib/fixtures/gd-topics";
import { AIRTIME_BAND } from "@/lib/gd/airtime";

// Speaker words share the interview room's humane treatment: display serif,
// large, centered. Chrome stays quiet UI sans.
const captionStyle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "1.35rem",
  lineHeight: 1.4,
  textWrap: "balance",
  margin: "0 auto",
  maxWidth: "60ch",
  textAlign: "center",
};

export default function GdPage() {
  return (
    <Suspense fallback={null}>
      <GdGate />
    </Suspense>
  );
}

function GdGate() {
  if (process.env.NEXT_PUBLIC_GD_ENABLED === "0") {
    return (
      <main className="wrap">
        <section className="card panel-enter">
          <h2>The GD room is disabled</h2>
          <p className="muted">
            Group Discussion practice is switched off on this deployment. Remove
            NEXT_PUBLIC_GD_ENABLED=0 to turn it back on.
          </p>
          <a className="btn" href="/" style={{ textDecoration: "none" }}>
            Back to setup
          </a>
        </section>
      </main>
    );
  }
  return <GdSetupOrRoom />;
}

function GdSetupOrRoom() {
  const params = useSearchParams();
  const [started, setStarted] = useState<{ topic: string; name: string } | null>(null);
  if (started) return <GdRoom topic={started.topic} name={started.name} />;
  return (
    <GdSetup
      initialName={params.get("name")?.slice(0, 60) ?? ""}
      onStart={(topic, name) => setStarted({ topic, name })}
    />
  );
}

function GdSetup({ initialName, onStart }: { initialName: string; onStart: (topic: string, name: string) => void }) {
  const [name, setName] = useState(() => {
    try {
      return initialName || window.sessionStorage.getItem("pds_gd_name") || "";
    } catch {
      return initialName;
    }
  });
  const [picked, setPicked] = useState(GD_TOPICS[0].topic);
  const [custom, setCustom] = useState("");
  const topic = custom.trim().slice(0, 200) || picked;

  const start = () => {
    try {
      window.sessionStorage.setItem("pds_gd_name", name.trim());
    } catch {}
    onStart(topic, name.trim() || "Candidate");
  };

  return (
    <main className="wrap">
      <h1>Group Discussion room</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Three AI candidates debate a topic with distinct voices — you fight for your share of the
        airtime, moderated by Anita. Scored on interjections and airtime.
      </p>

      <section aria-label="Pick a topic" style={{ margin: "var(--space-4) 0" }}>
        <div className="small" style={{ fontWeight: 600, marginBottom: 10 }}>
          Topic
        </div>
        <div
          role="radiogroup"
          aria-label="Discussion topic"
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}
        >
          {GD_TOPICS.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={!custom.trim() && picked === t.topic}
              className="choice"
              onClick={() => {
                setPicked(t.topic);
                setCustom("");
              }}
            >
              <span className="choice-title" style={{ fontSize: "0.9rem" }}>{t.topic}</span>
            </button>
          ))}
        </div>
        <div className="field" style={{ marginTop: 16, maxWidth: 520 }}>
          <label htmlFor="gd-custom">Or your own topic</label>
          <input
            id="gd-custom"
            value={custom}
            maxLength={200}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="e.g. Exams should be open-book"
          />
        </div>
      </section>

      <div style={{ display: "grid", gap: 20, maxWidth: 520 }}>
        <div className="field">
          <label htmlFor="gd-name">Your name</label>
          <input
            id="gd-name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Hari"
          />
          <span className="hint">The moderator uses it.</span>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button className="btn" onClick={start}>
            Enter the room
          </button>
          <a className="btn quiet" href="/" style={{ textDecoration: "none" }}>
            Back
          </a>
        </div>
      </div>
    </main>
  );
}

// ——— the room ———

type M = ReturnType<typeof useGdMachine>;

function GdRoom({ topic, name }: { topic: string; name: string }) {
  const router = useRouter();
  const m = useGdMachine(name, topic);
  const [spaceDown, setSpaceDown] = useState(false);

  const inRoom = m.phase === "discussion" || m.phase === "wrapup";

  // Leaving mid-discussion loses the round — warn (UX spec, same as 1:1).
  useEffect(() => {
    const inProgress = inRoom;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (inProgress) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [inRoom]);

  // Keyboard: hold SPACE grabs the floor; Enter hands it back. Never steal
  // keys from a focused control (a11y floor, same guard as the 1:1 room).
  useEffect(() => {
    const onControl = () => {
      const el = document.activeElement;
      return el instanceof HTMLElement && el.closest("button, a, input, select, textarea") && !el.dataset.floorKey;
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && inRoom) {
        if (onControl()) return;
        e.preventDefault();
        setSpaceDown(true);
        m.takeFloor();
      }
      if (e.key === "Enter" && inRoom && m.candidateHasFloor) {
        if (onControl()) return;
        e.preventDefault();
        m.endFloorNow();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [m, inRoom]);

  const leave = () => {
    m.cleanup();
    router.push("/");
  };

  return (
    <main className="wrap">
      {/* Minimal room chrome — topic left, timer + leave right. */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: "var(--space-4)",
        }}
      >
        <div
          className="small"
          style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {m.phase !== "done" ? topic : "Discussion complete"}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
          {inRoom && <RoomTimer startedAt={m.discussionStartedAt} />}
          <button className="btn quiet" onClick={leave}>
            Leave
          </button>
        </div>
      </header>

      {m.phase === "micCheck" && <GdMicCheck m={m} />}
      {m.phase === "preroll" && <GdPreroll m={m} />}
      {inRoom && <Room m={m} spaceDown={spaceDown} />}
      {m.phase === "done" && <GdScorecard m={m} />}

      {/* Screen-reader announcements — phase swaps unmount focused controls. */}
      <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>
        {m.phase === "preroll" && "Mic check passed. Discussion instructions shown."}
        {m.candidateHasFloor && "You have the floor."}
        {m.phase === "wrapup" && "The moderator is wrapping up."}
        {m.phase === "done" && "Discussion complete. Your results are shown."}
      </div>

      {inRoom && (
        <p className="small muted" style={{ marginTop: "var(--space-5)", textAlign: "center" }}>
          Keep this tab active — browsers pause speech in background tabs. Headphones make barge-in seamless.
        </p>
      )}
    </main>
  );
}

function RoomTimer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (startedAt === null) return null;
  const left = Math.max(0, GD_CAP_MS - (now - startedAt));
  const mm = Math.floor(left / 60000);
  const ss = Math.floor((left % 60000) / 1000);
  return (
    <span className="small muted mono-num" aria-label="Time remaining">
      {mm}:{ss.toString().padStart(2, "0")}
    </span>
  );
}

function GdMicCheck({ m }: { m: M }) {
  const started = m.micCheckTranscript.length > 0 || m.hearing;
  return (
    <section className="card panel-enter">
      <h2>Quick mic check</h2>
      {!m.micBlocked ? (
        <>
          <p className="muted">
            The GD room is voice-only — you literally fight for airtime with your voice. Click below,
            then <strong>say your name</strong> out loud. Nothing is recorded or uploaded.
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
              <span className="small muted">Heard</span>{" "}
              <span className="display" style={{ fontStyle: "italic", fontSize: "1.1rem" }}>
                “{m.micCheckTranscript}”
              </span>
            </p>
          )}
          <div style={{ marginTop: 16 }}>
            <button className="btn" onClick={m.confirmMicCheck} disabled={!started}>
              Sounds right — into the room
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            The microphone isn't available ({m.micBlocked}). The GD room needs voice — check the
            address-bar mic permission (or use Google Chrome) and try again.
          </p>
          <button className="btn" onClick={m.beginMicCheck}>
            Try microphone again
          </button>
        </>
      )}
    </section>
  );
}

function GdPreroll({ m }: { m: M }) {
  const [lo, hi] = AIRTIME_BAND;
  return (
    <section className="card panel-enter">
      <h2>Before the discussion starts</h2>
      <p>
        Anita moderates. <strong>Vikram, Meera, and Rohan</strong> will debate hard for about{" "}
        <strong>4½ minutes</strong> — they will not stop to ask what you think.
      </p>
      <p>
        <strong>Just start talking to interrupt</strong> — or hold <kbd>Space</kbd> to grab the
        floor. Pausing for ~1.5 seconds (or pressing <kbd>Enter</kbd>) hands it back. Aim for {lo}–{hi}% of the
        airtime, and build on the previous speaker's point when you jump in.
      </p>
      <button className="btn" onClick={m.startDiscussion}>
        Start the discussion
      </button>
    </section>
  );
}

/** Identity chip in the persona rail — name + a 10px hue dot; the active
 * speaker's chip lifts subtly. The orb (below) carries the actual life. */
function RailChip({
  name,
  hue,
  active,
  children,
}: {
  name: string;
  hue: number | null;
  active: boolean;
  children?: ReactNode;
}) {
  const activeStyle: CSSProperties = active
    ? {
        color: "var(--text)",
        background: "var(--surface-raised)",
        borderColor: "var(--border-strong)",
        transform: "scale(1.06)",
      }
    : {};
  return (
    <span
      className="chip"
      style={{
        transition: "transform var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out)",
        ...activeStyle,
      }}
    >
      {children ?? (
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: hue === null ? "var(--text)" : `hsl(${hue} 55% 62%)`,
            flexShrink: 0,
          }}
        />
      )}
      {name}
    </span>
  );
}

function Room({ m, spaceDown }: { m: M; spaceDown: boolean }) {
  const debaters = m.personas.filter((p) => p.id !== "moderator");
  const share = m.metrics?.airtimeSharePct ?? 0;
  const interjections = m.metrics?.interjections ?? [];
  const built = interjections.filter((i) => i.builtOnPrevious).length;
  const [lo, hi] = AIRTIME_BAND;
  const floorHot = m.candidateHasFloor || spaceDown;
  const activeDebater = debaters.find((p) => p.id === m.activeSpeaker) ?? null;

  // Transcript rail auto-scroll: newest line stays in view.
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = railRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [m.transcript.length]);

  return (
    <section>
      {/* Persona rail: everyone in the room as identity chips. The candidate's
          chip carries the level bars while they hold the floor (mic = live). */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginBottom: "var(--space-3)" }}>
        {m.personas.map((p) => (
          <RailChip key={p.id} name={p.name} hue={p.hue[0]} active={m.activeSpeaker === p.id} />
        ))}
        {m.candidateHasFloor ? (
          <span className="chip live">
            <span className="level active" aria-hidden style={{ height: 12, transform: "scale(0.6)", transformOrigin: "center" }}>
              <span /><span /><span /><span />
            </span>
            You
          </span>
        ) : (
          <RailChip name="You" hue={null} active={false} />
        )}
      </div>

      {/* The stage: the VoiceOrb mounts ONLY for the active debater (same
          logic as before); Anita gets her quiet monogram; the candidate's
          floor time shows the real hearing bars. Fixed height — no jumping. */}
      <div
        style={{ height: 136, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "var(--space-2)" }}
        aria-hidden
      >
        {activeDebater ? (
          <VoiceOrb size={120} hue={activeDebater.hue} />
        ) : m.activeSpeaker === "moderator" ? (
          <span className="monogram speaking">A</span>
        ) : m.candidateHasFloor ? (
          <span className={`level ${m.hearing ? "active" : ""}`} style={{ transform: "scale(1.7)" }}>
            <span /><span /><span /><span />
          </span>
        ) : null}
      </div>

      {/* Live caption — always rendered (a11y + noisy rooms). */}
      <div
        aria-live="polite"
        style={{
          minHeight: 110,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          textAlign: "center",
        }}
      >
        {m.candidateHasFloor ? (
          <>
            <span className="chip live">
              <span className="dot" />
              You have the floor
            </span>
            <p className="small muted" style={{ margin: 0 }}>
              pause or press <kbd>Enter</kbd> to hand it back
            </p>
            {m.lastSentence && (
              <p className="small muted" style={{ margin: 0 }}>
                …{m.lastSentence}
              </p>
            )}
          </>
        ) : m.caption ? (
          <>
            <div className="small" style={{ fontWeight: 600 }}>{m.caption.speaker}</div>
            <p style={captionStyle}>{m.caption.text}</p>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {m.thinking ? "The room takes a breath…" : "…"}
          </p>
        )}
      </div>

      {/* LIVE airtime: one quiet track, the target band tinted --ok underneath,
          your share filled in ink — switching to recording red past the band. */}
      <div style={{ marginTop: "var(--space-3)" }}>
        <div className="small" style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span className="mono-num">
            <strong>{share}%</strong> <span className="muted">your airtime</span>
            {interjections.length > 0 && (
              <span className="muted">
                {" "}· {interjections.length} interjection{interjections.length === 1 ? "" : "s"} ({built} built on a point)
              </span>
            )}
          </span>
          <span className="muted mono-num">target {lo}–{hi}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="Your share of the airtime"
          aria-valuenow={Math.round(share)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{
            position: "relative",
            height: 8,
            marginTop: 8,
            background: "var(--surface-2)",
            borderRadius: "var(--radius-pill)",
            overflow: "hidden",
          }}
        >
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: `${lo}%`,
              width: `${hi - lo}%`,
              top: 0,
              bottom: 0,
              background: "color-mix(in oklab, var(--ok) 22%, transparent)",
            }}
          />
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              width: `${Math.min(100, share)}%`,
              top: 0,
              bottom: 0,
              background: share > hi ? "var(--live)" : "var(--accent)",
              borderRadius: "var(--radius-pill)",
              transition: "width 0.4s var(--ease-out)",
            }}
          />
        </div>
      </div>

      {/* Floor controls: the SPACE hint doubles as a press/hold target. */}
      <div style={{ marginTop: "var(--space-3)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
        <button
          className="btn secondary"
          data-floor-key="true"
          onMouseDown={m.takeFloor}
          // Keyboard/AT path: Enter/Space and single-click activation grab the
          // floor exactly like the mouse path (takeFloor is idempotent while held).
          onClick={m.takeFloor}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              m.takeFloor();
            }
          }}
          style={floorHot ? { borderColor: "var(--live)", color: "var(--live)" } : undefined}
        >
          {m.candidateHasFloor ? (
            "You're speaking…"
          ) : (
            <>
              <kbd>Space</kbd> hold to jump in
            </>
          )}
        </button>
        {m.candidateHasFloor && (
          <button className="btn secondary" data-floor-key="true" onClick={m.endFloorNow}>
            Done (Enter)
          </button>
        )}
        <span className={`level ${m.hearing ? "active" : ""}`} aria-hidden>
          <span /><span /><span /><span />
        </span>
        <span className="small muted">mic is live the whole time</span>
      </div>

      {m.micBlocked && (
        <div className="card tinted small" style={{ marginTop: 12 }}>
          <strong>Mic trouble</strong> ({m.micBlocked}) — your words may not be transcribed. Check the
          address-bar mic permission.
        </div>
      )}

      {/* Low-emphasis transcript rail — speaker names carry the weight. */}
      {m.transcript.length > 0 && (
        <div
          ref={railRef}
          style={{ marginTop: "var(--space-3)", maxHeight: 180, overflowY: "auto", borderTop: "1px solid var(--border)", paddingTop: 10 }}
        >
          {m.transcript.map((t, i) => (
            <p key={i} className="small" style={{ margin: "0 0 6px" }}>
              <span style={{ fontWeight: 600 }}>{t.speaker === "candidate" ? "You" : t.personaName ?? "—"}</span>{" "}
              <span className="muted">{t.text}</span>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function GdScorecard({ m }: { m: M }) {
  const s = m.session;
  if (!s) return null;
  const gm = s.gdMetrics ?? m.metrics;
  const built = gm?.interjections.filter((i) => i.builtOnPrevious).length ?? 0;
  const [lo, hi] = AIRTIME_BAND;
  const debaters = m.personas.filter((p) => p.id !== "moderator");

  return (
    <section className="panel-enter">
      <h2>Discussion complete</h2>

      {/* FIRST: the verdict — score + coach summary, raised above the page. */}
      <div className="card raised" style={{ margin: "0 0 var(--space-4)" }}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: "2.4rem", lineHeight: 1 }} className="mono-num">
          {s.overall.avgScore !== null ? (
            <>
              {s.overall.avgScore.toFixed(1)}
              <span className="muted" style={{ fontSize: "1.2rem" }}>/5</span>
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </div>
        <p style={{ margin: "8px 0 0" }}>{s.overall.summary}</p>
      </div>

      {!m.sessionPersisted && (
        <div className="card tinted" role="status" style={{ margin: "0 0 var(--space-4)" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Couldn't save</div>
          <div className="small">
            This device can't store sessions (private browsing?) — this round disappears when the tab closes.
          </div>
        </div>
      )}

      {gm && (
        <div className="card" style={{ margin: "0 0 var(--space-4)" }}>
          <table className="plain mono-num" aria-label="Airtime metrics">
            <tbody>
              <tr>
                <td>Your airtime share</td>
                <td>
                  {gm.airtimeSharePct}% <span className="muted">(target {lo}–{hi}%)</span>
                </td>
              </tr>
              <tr>
                <td>Times you spoke</td>
                <td>{gm.candidateTurns}</td>
              </tr>
              <tr>
                <td>Interjections</td>
                <td>
                  {gm.interjections.length} <span className="muted">({built} built on the previous point)</span>
                </td>
              </tr>
              <tr>
                <td>Your speaking time</td>
                <td>{(gm.candidateAirtimeMs / 1000).toFixed(0)}s</td>
              </tr>
              {debaters.map((p) => (
                <tr key={p.id}>
                  <td className="muted">{p.name}</td>
                  <td className="muted">{((gm.personaAirtimeMs[p.id] ?? 0) / 1000).toFixed(0)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <a className="btn" href={`/report/${s._id}`} style={{ textDecoration: "none" }}>
          View full report →
        </a>
        <a className="btn secondary" href="/" style={{ textDecoration: "none" }}>
          Practice again
        </a>
      </div>
    </section>
  );
}
