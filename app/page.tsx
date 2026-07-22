"use client";

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { extractPdfText, ResumeExtractError } from "@/lib/resume-extract";
import { getVoiceEngine, hasStoredVoiceChoice, kokoroStatus, setVoiceEngine, type VoiceEngine } from "@/lib/tts";
import { getPreferredVoice, setPreferredVoice } from "@/lib/voices";

// Landing = the setup screen (binding UX spec). No marketing hero: the round
// picker is the first thing on the page, and one real sample scorecard row sits
// above the fold as proof of what you get.

const GD_ON = process.env.NEXT_PUBLIC_GD_ENABLED !== "0";

type Round = "hr" | "technical" | "gd";

const ROUNDS: { id: Round; title: string; desc: string }[] = [
  { id: "hr", title: "HR interview", desc: "Tell-me-about-yourself, strengths, situations — the classic opener round." },
  { id: "technical", title: "Technical interview", desc: "Deep-dives on your stack, plus a hands-on coding question in a real editor." },
  { id: "gd", title: "Group discussion", desc: "Debate three AI candidates for airtime — the round no other tool simulates." },
];

// Roving tabindex for the page's custom radio groups (WAI-ARIA radio
// pattern): one tab stop per group; Arrow keys move selection AND focus,
// wrapping at the ends. `values` must list the enabled radios in DOM order.
function rovingRadio<T>(values: T[], selected: T | null, select: (v: T) => void) {
  const activeIdx = Math.max(0, values.findIndex((v) => v === selected));
  return (v: T) => ({
    tabIndex: values.indexOf(v) === activeIdx ? 0 : -1,
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      const dir =
        e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 :
        e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (dir === 0) return;
      e.preventDefault();
      const next = (values.indexOf(v) + dir + values.length) % values.length;
      select(values[next]);
      const radios = e.currentTarget
        .closest('[role="radiogroup"]')
        ?.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])');
      radios?.[next]?.focus();
    },
  });
}

// Curated studio voices (28 available on the local server — these four carry).
const STUDIO_VOICES: { file: string; name: string; desc: string }[] = [
  { file: "Elena.wav", name: "Elena", desc: "warm, steady — the default" },
  { file: "Gianna.wav", name: "Gianna", desc: "bright, quick" },
  { file: "Adrian.wav", name: "Adrian", desc: "low-key, thoughtful" },
  { file: "Olivia.wav", name: "Olivia", desc: "crisp, formal" },
];

export default function SetupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [role, setRole] = useState("general");
  const [engine, setEngine] = useState<VoiceEngine>("system");
  const [voiceFile, setVoiceFile] = useState<string | null>(null);
  const [elevenAvailable, setElevenAvailable] = useState(false);
  const [chatterboxAvailable, setChatterboxAvailable] = useState(false);
  const [kokoro, setKokoro] = useState("off");
  const [round, setRound] = useState<Round>("hr");
  const [resume, setResume] = useState("");
  const [analysis, setAnalysis] = useState<{
    strengths: string[];
    gaps: string[];
    talkingPoints: string[];
    atsScore: number;
    missingSkills: string[];
    improvements: string[];
  } | null>(null);
  const [analyzer, setAnalyzer] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const onPdfPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setAnalyzeError(null);
    setExtracting(true);
    try {
      // Extraction runs entirely in this browser — the PDF never leaves the
      // device. Only the extracted text lands in the (still editable) field.
      const text = await extractPdfText(file);
      setResume(text);
      setAnalysis(null); // stale analysis would describe the old text
    } catch (err) {
      setAnalyzeError(
        err instanceof ResumeExtractError ? err.message : "Couldn't read that PDF — paste the text instead.",
      );
    } finally {
      setExtracting(false);
    }
  };

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
      // 429s carry a friendly d.message (quota text) — prefer it over the
      // machine code in d.error.
      if (!res.ok) throw new Error((typeof d.message === "string" && d.message) || d.error || "analysis failed");
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
    setVoiceFile(getPreferredVoice());
    const probe = () =>
      fetch("/api/tts")
        .then((r) => r.json())
        .then((d) => {
          setElevenAvailable(Boolean(d.elevenlabs ?? d.enabled));
          setChatterboxAvailable(Boolean(d.chatterbox));
          // First visit + the local studio server is running → it IS the
          // default (user verdict: the best voice available). An explicit
          // choice is never overridden.
          if (d.chatterbox && !hasStoredVoiceChoice()) {
            setVoiceEngine("chatterbox");
            setEngine("chatterbox");
          }
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

  const pickStudioVoice = (file: string) => {
    pickEngine("chatterbox");
    setPreferredVoice(file);
    setVoiceFile(file);
  };

  const start = () => {
    if (round === "gd") {
      router.push(`/gd${name.trim() ? `?name=${encodeURIComponent(name.trim())}` : ""}`);
      return;
    }
    try {
      if (resume.trim()) window.sessionStorage.setItem("pds_resume", resume.trim());
      else window.sessionStorage.removeItem("pds_resume");
    } catch {}
    const params = new URLSearchParams({ name: name.trim() || "Candidate", role, round });
    router.push(`/interview?${params.toString()}`);
  };

  const studioSelected = engine === "chatterbox";
  const activeStudioFile = voiceFile ?? "Elena.wav";

  const roundRadio = rovingRadio(
    ROUNDS.filter((r) => !(r.id === "gd" && !GD_ON)).map((r) => r.id),
    round,
    setRound,
  );
  const studioRadio = rovingRadio(
    STUDIO_VOICES.map((v) => v.file),
    studioSelected ? activeStudioFile : null,
    pickStudioVoice,
  );
  const engineRadio = rovingRadio<VoiceEngine>(
    ["kokoro", "system", ...(elevenAvailable ? (["elevenlabs"] as const) : [])],
    engine,
    pickEngine,
  );

  return (
    <main className="wrap">
      <h1>Rehearse the real thing.</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        A live voice interview with real feedback — spoken questions, adaptive deep-dives, and a scorecard
        built from your own words.
      </p>

      {/* Proof, before the first click: a real sample scorecard row. */}
      <figure className="card tinted" style={{ margin: "24px 0 32px", padding: "18px 20px" }}>
        <figcaption className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
          Sample feedback <span className="muted" style={{ fontWeight: 500 }}>· structure 4/5</span>
        </figcaption>
        <p className="display" style={{ margin: 0, fontSize: "1.08rem", lineHeight: 1.5 }}>
          “I split the migration into three checkpoints so we could roll back at each stage” — clear
          situation-action-result shape. Lead with the outcome next time to score 5.
        </p>
      </figure>

      <section aria-label="Pick your round" style={{ marginBottom: 32 }}>
        <div role="radiogroup" aria-label="Interview round" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {ROUNDS.map((r) => {
            const disabled = r.id === "gd" && !GD_ON;
            return (
              <button
                key={r.id}
                role="radio"
                aria-checked={round === r.id}
                className="choice"
                disabled={disabled}
                onClick={() => setRound(r.id)}
                {...(disabled ? undefined : roundRadio(r.id))}
              >
                <span className="choice-title">
                  {r.title}
                  {r.id === "gd" && !disabled && <span className="chip on"><span className="dot" />new</span>}
                </span>
                <span className="choice-desc">{disabled ? "In the works." : r.desc}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div style={{ display: "grid", gap: 24, maxWidth: 520 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Hari"
            />
            <span className="hint">The interviewer uses it.</span>
          </div>
          <div className="field">
            <label htmlFor="role">Target role</label>
            <select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="general">General fresher</option>
              <option value="java-sde-fresher">Java SDE fresher</option>
              <option value="frontend-fresher">Frontend fresher</option>
            </select>
          </div>
        </div>

        <details>
          <summary className="small" style={{ cursor: "pointer", color: "var(--muted)" }}>
            Add your resume (optional — the interviewer asks about YOUR projects)
          </summary>
          <div className="field" style={{ marginTop: 10 }}>
            <textarea
              rows={7}
              value={resume}
              maxLength={15000}
              onChange={(e) => setResume(e.target.value)}
              placeholder="Paste resume text here, or upload the PDF below. It stays in this browser session."
            />
            <p className="small muted" style={{ margin: "4px 0 0" }}>
              PDFs are read entirely in this browser — the file never leaves your device; only the
              extracted text is used. Still, avoid sensitive personal data (phone, address).
            </p>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input ref={pdfInputRef} type="file" accept=".pdf" hidden onChange={onPdfPick} />
              <button className="btn secondary" onClick={() => pdfInputRef.current?.click()} disabled={extracting}>
                {extracting ? "Reading PDF…" : "Upload PDF resume"}
              </button>
              <button className="btn secondary" onClick={analyze} disabled={analyzing || resume.trim().length < 80}>
                {analyzing ? "Analyzing…" : "Analyze my resume"}
              </button>
              {analyzeError && <span className="small" style={{ color: "var(--live)" }}>{analyzeError}</span>}
            </div>
            {analysis && (
              <div className="card" style={{ marginTop: 10 }}>
                <div className="small" style={{ fontWeight: 600 }}>
                  Resume read{analyzer === "heuristic" ? " · basic check (brain offline)" : ""}
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, margin: "10px 0 0" }}>
                  <span className="display" style={{ fontSize: "2.4rem", lineHeight: 1 }}>{analysis.atsScore}</span>
                  <span className="muted">/100</span>
                  <span className="small muted" style={{ marginLeft: 6 }}>ATS readiness</span>
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
                {analysis.missingSkills.length > 0 && (
                  <>
                    <p style={{ margin: "8px 0 6px" }}><strong>Missing skills</strong></p>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {analysis.missingSkills.map((s, i) => <span key={i} className="chip">{s}</span>)}
                    </div>
                  </>
                )}
                {analysis.improvements.length > 0 && (
                  <>
                    <p style={{ margin: "8px 0 2px" }}><strong>Improvements</strong></p>
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {analysis.improvements.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        </details>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="field">
          <legend className="small" style={{ fontWeight: 600, padding: 0, marginBottom: 8 }}>
            Interviewer voice
          </legend>

          {chatterboxAvailable ? (
            <div role="radiogroup" aria-label="Studio voices" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {STUDIO_VOICES.map((v) => (
                <button
                  key={v.file}
                  role="radio"
                  aria-checked={studioSelected && activeStudioFile === v.file}
                  className="choice"
                  onClick={() => pickStudioVoice(v.file)}
                  {...studioRadio(v.file)}
                >
                  <span className="choice-title">
                    {v.name}
                    {v.file === "Elena.wav" && <span className="chip on"><span className="dot" />studio</span>}
                  </span>
                  <span className="choice-desc">{v.desc}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="card tinted small muted">
              Studio voices are offline — start the local voice server (~/chatterbox-tts-server/run.sh) and
              they light up here. Clone your own voice at localhost:8004.
            </div>
          )}

          <div
            role="radiogroup"
            aria-label="Voice engine"
            style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}
          >
            <button
              role="radio"
              aria-checked={engine === "kokoro"}
              className="choice"
              style={{ flex: "1 1 180px" }}
              onClick={() => pickEngine("kokoro")}
              {...engineRadio("kokoro")}
            >
              <span className="choice-title">On-device</span>
              <span className="choice-desc">
                Kokoro — natural, offline, ~80MB once
                {engine === "kokoro" && kokoro === "loading" && " · downloading…"}
                {engine === "kokoro" && kokoro === "ready" && " · ready"}
                {engine === "kokoro" && kokoro === "failed" && " · failed — system voice fills in"}
              </span>
            </button>
            <button
              role="radio"
              aria-checked={engine === "system"}
              className="choice"
              style={{ flex: "1 1 180px" }}
              onClick={() => pickEngine("system")}
              {...engineRadio("system")}
            >
              <span className="choice-title">System</span>
              <span className="choice-desc">Instant, robotic. The floor.</span>
            </button>
            {elevenAvailable && (
              <button
                role="radio"
                aria-checked={engine === "elevenlabs"}
                className="choice"
                style={{ flex: "1 1 180px" }}
                onClick={() => pickEngine("elevenlabs")}
                {...engineRadio("elevenlabs")}
              >
                <span className="choice-title">Cloud</span>
                <span className="choice-desc">ElevenLabs</span>
              </button>
            )}
          </div>
        </fieldset>

        <div>
          <button className="btn" style={{ width: "100%", fontSize: "1rem" }} onClick={start}>
            {round === "hr" ? "Start HR interview" : round === "technical" ? "Start technical interview" : "Start group discussion"}
          </button>
          <p className="small muted" style={{ margin: "10px 0 0" }}>
            Voice interviews need Chrome on a laptop with a microphone. No login, nothing uploaded — your
            session stays on this device.
          </p>
        </div>
      </div>
    </main>
  );
}
