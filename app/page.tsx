"use client";

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { extractPdfText, ResumeExtractError } from "@/lib/resume-extract";
import { buildResumeProfile } from "@/lib/resume-profile";
import { setVoiceEngine } from "@/lib/tts";
import { setPreferredVoice } from "@/lib/voices";
import type { CodeLanguage } from "@/lib/types";
import { Hero } from "@/components/Hero";

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

// All five coding-round languages — the exercise and the Monaco editor follow
// this choice (values are Monaco language ids, pinned as CodeLanguage).
const CODE_LANGS: { id: CodeLanguage; label: string }[] = [
  { id: "java", label: "Java" },
  { id: "python", label: "Python" },
  { id: "cpp", label: "C++" },
  { id: "javascript", label: "JavaScript" },
  { id: "c", label: "C" },
];


export default function SetupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [role, setRole] = useState("general");
  const [round, setRound] = useState<Round>("hr");
  const [codeLang, setCodeLang] = useState<CodeLanguage>("java");
  const [bargeIn, setBargeIn] = useState(false);
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
  const autoAnalyzeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoAnalyzedRef = useRef("");

  // Every resume-text change re-derives the deterministic profile so the
  // interview page can read it even on paste-then-immediately-start.
  const writeProfile = (text: string) => {
    try {
      const t = text.trim();
      if (t) window.sessionStorage.setItem("pds_resume_profile", JSON.stringify(buildResumeProfile(t)));
      else window.sessionStorage.removeItem("pds_resume_profile");
    } catch {}
  };

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
      writeProfile(text);
      // Auto-analyze the extraction (80 = the API's minimum); the button
      // stays as a manual re-run.
      if (text.trim().length >= 80) {
        lastAutoAnalyzedRef.current = text.trim();
        void analyze(text);
      }
    } catch (err) {
      setAnalyzeError(
        err instanceof ResumeExtractError ? err.message : "Couldn't read that PDF — paste the text instead.",
      );
    } finally {
      setExtracting(false);
    }
  };

  // Typed/pasted changes: profile is instant; a substantial paste (≥300 chars)
  // auto-analyzes after 1.5s of quiet so mid-edit keystrokes don't burn calls.
  const onResumeChange = (text: string) => {
    setResume(text);
    writeProfile(text);
    if (autoAnalyzeTimerRef.current) clearTimeout(autoAnalyzeTimerRef.current);
    const t = text.trim();
    if (t.length >= 300 && t !== lastAutoAnalyzedRef.current) {
      autoAnalyzeTimerRef.current = setTimeout(() => {
        lastAutoAnalyzedRef.current = t;
        void analyze(t);
      }, 1500);
    }
  };

  const analyze = async (textOverride?: string) => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await fetch("/api/resume-analysis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume: textOverride ?? resume }),
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
    // One voice — Emily. Studio-quality when the local voice server is up,
    // otherwise the fast on-device voice fills in silently. No picker.
    setPreferredVoice("Emily.wav");
    fetch("/api/tts")
      .then((r) => r.json())
      .then((d) => setVoiceEngine(d.chatterbox ? "chatterbox" : "kokoro"))
      .catch(() => setVoiceEngine("kokoro"));
    // Restore a previously chosen coding language (set in-effect, not in the
    // initializer — sessionStorage reads during SSR/hydration would mismatch).
    try {
      const stored = window.sessionStorage.getItem("pds_code_lang");
      if (CODE_LANGS.some((l) => l.id === stored)) setCodeLang(stored as CodeLanguage);
    } catch {}
    return () => {
      if (autoAnalyzeTimerRef.current) clearTimeout(autoAnalyzeTimerRef.current);
    };
  }, []);

  const pickCodeLang = (lang: CodeLanguage) => {
    setCodeLang(lang);
    try {
      window.sessionStorage.setItem("pds_code_lang", lang);
    } catch {}
  };

  const start = () => {
    if (round === "gd") {
      router.push(`/gd${name.trim() ? `?name=${encodeURIComponent(name.trim())}` : ""}`);
      return;
    }
    try {
      const trimmed = resume.trim();
      if (trimmed) {
        window.sessionStorage.setItem("pds_resume", trimmed);
        // Written BEFORE navigation — covers paste-then-immediately-start.
        window.sessionStorage.setItem("pds_resume_profile", JSON.stringify(buildResumeProfile(trimmed)));
      } else {
        window.sessionStorage.removeItem("pds_resume");
        window.sessionStorage.removeItem("pds_resume_profile");
      }
      window.sessionStorage.setItem("pds_code_lang", codeLang);
      window.sessionStorage.setItem("pds_barge_in", bargeIn ? "1" : "0");
    } catch {}
    const params = new URLSearchParams({ name: name.trim() || "Candidate", role, round });
    router.push(`/interview?${params.toString()}`);
  };

  const roundRadio = rovingRadio(
    ROUNDS.filter((r) => !(r.id === "gd" && !GD_ON)).map((r) => r.id),
    round,
    setRound,
  );

  return (
    <main>
      <Hero />

      <section id="setup" className="wrap setup">
        <div className="section-head">
          <h2 className="section-title">Set up your session</h2>
          <p className="section-sub">
            Pick a round, add a few details, and start talking. It takes under a minute — no login,
            nothing uploaded.
          </p>
        </div>

        <div className="setup-body">
          {/* Proof, before the first click: a real sample scorecard row. */}
          <figure className="feature-card proof">
            <figcaption className="proof-label">
              Sample feedback <span className="badge ok">structure 4/5</span>
            </figcaption>
            <p className="proof-quote">
              “I split the migration into three checkpoints so we could roll back at each stage” — clear
              situation-action-result shape. Lead with the outcome next time to score 5.
            </p>
          </figure>

          <div role="radiogroup" aria-label="Interview round" className="round-grid">
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

          <div className="setup-form">
            <div className="field-row">
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

            {/* Technical-round options: the coding exercise + editor follow this. */}
            {round === "technical" && (
              <div className="field">
                <label htmlFor="code-lang">Coding language</label>
                <select id="code-lang" value={codeLang} onChange={(e) => pickCodeLang(e.target.value as CodeLanguage)}>
                  {CODE_LANGS.map((l) => (
                    <option key={l.id} value={l.id}>{l.label}</option>
                  ))}
                </select>
                <span className="hint">The hands-on question and editor match it.</span>
              </div>
            )}

            <details className="disclosure">
              <summary>Add your resume (optional — the interviewer asks about YOUR projects)</summary>
              <div className="disclosure-body">
                <div className="field">
                  <textarea
                    rows={7}
                    value={resume}
                    maxLength={15000}
                    onChange={(e) => onResumeChange(e.target.value)}
                    placeholder="Paste resume text here, or upload the PDF below. It stays in this browser session."
                  />
                  <span className="hint">
                    PDFs are read entirely in this browser — the file never leaves your device; only the
                    extracted text is used. Still, avoid sensitive personal data (phone, address).
                  </span>
                </div>
                <div className="inline-actions">
                  <input ref={pdfInputRef} type="file" accept=".pdf" hidden onChange={onPdfPick} />
                  <button className="btn secondary" onClick={() => pdfInputRef.current?.click()} disabled={extracting}>
                    {extracting ? "Reading PDF…" : "Upload PDF resume"}
                  </button>
                  <button className="btn secondary" onClick={() => analyze()} disabled={analyzing || resume.trim().length < 80}>
                    {analyzing ? "Analyzing…" : "Analyze my resume"}
                  </button>
                  {analyzeError && <span className="error">{analyzeError}</span>}
                </div>
                {analysis && (
                  <div className="card analysis">
                    <div className="analysis-title">
                      Resume read{analyzer === "heuristic" ? " · basic check (brain offline)" : ""}
                    </div>
                    <div className="ats-score">
                      <span className="n">{analysis.atsScore}</span>
                      <span className="muted">/100</span>
                      <span className="small muted">ATS readiness</span>
                    </div>
                    <p>Working for you</p>
                    <ul>
                      {analysis.strengths.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                    <p>An interviewer will probe</p>
                    <ul>
                      {analysis.gaps.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                    <p>Bring these up yourself</p>
                    <ul>
                      {analysis.talkingPoints.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                    {analysis.missingSkills.length > 0 && (
                      <>
                        <p>Missing skills</p>
                        <div className="chip-row">
                          {analysis.missingSkills.map((s, i) => <span key={i} className="chip">{s}</span>)}
                        </div>
                      </>
                    )}
                    {analysis.improvements.length > 0 && (
                      <>
                        <p>Improvements</p>
                        <ul>
                          {analysis.improvements.map((s, i) => <li key={i}>{s}</li>)}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>
            </details>

            {round !== "gd" && (
              <label className="card tinted toggle-card">
                <input
                  type="checkbox"
                  checked={bargeIn}
                  onChange={(e) => setBargeIn(e.target.checked)}
                />
                <span>
                  <span className="toggle-title">Let me interrupt the interviewer</span>
                  <span className="choice-desc">
                    Off by default — she finishes each question, then you answer. Turn on only with headphones,
                    or room noise will cut her off mid-question.
                  </span>
                </span>
              </label>
            )}

            <div>
              <button className="btn block lg" onClick={start}>
                {round === "hr" ? "Start HR interview" : round === "technical" ? "Start technical interview" : "Start group discussion"}
              </button>
              <p className="small muted start-note">
                Voice interviews need Chrome on a laptop with a microphone. No login, nothing uploaded — your
                session stays on this device.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
