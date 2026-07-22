"use client";

import { useCallback, useEffect, useState } from "react";
import { guidanceCacheKey } from "@/lib/guidance-key";
import type { Guidance } from "@/lib/llm/guidance";
import { CRITERION_LABEL, latestWeakest, scoredSessions, sessionAvg, type FixFirst } from "@/lib/report-utils";
import { loadSessions } from "@/lib/session-store";
import type { RolePreset } from "@/lib/types";

// Guidance — department modules 9+10 on one page: what to close, learn and
// aim for. The client composes its own inputs (localStorage sessions +
// sessionStorage resume); the server never reads sessions.

const CACHE_KEY = "pds_guidance_v1";
const ROLES: readonly RolePreset[] = ["general", "java-sde-fresher", "frontend-fresher"];

interface GuidanceResult {
  guidance: Guidance;
  source: "claude-cli" | "heuristic";
}

interface Inputs {
  role: RolePreset;
  resumeText?: string;
  performance: { avgScore: number | null; weakestCriterion: string | null; sessionsCount: number };
}

// Cached payloads are user-editable JSON — structural check before rendering,
// same rationale as session-store's isSessionLike.
function isGuidanceLike(value: unknown): value is Guidance {
  if (typeof value !== "object" || value === null) return false;
  const g = value as Record<string, unknown>;
  const strings = (a: unknown) =>
    Array.isArray(a) && a.length > 0 && a.every((s) => typeof s === "string");
  const steps =
    Array.isArray(g.learningPath) &&
    g.learningPath.length > 0 &&
    g.learningPath.every((s) => {
      const o = s as Record<string, unknown>;
      return typeof o?.skill === "string" && typeof o?.why === "string" && typeof o?.resource === "string";
    });
  const roles =
    Array.isArray(g.roles) &&
    g.roles.length > 0 &&
    g.roles.every((r) => {
      const o = r as Record<string, unknown>;
      return typeof o?.title === "string" && typeof o?.why === "string" && strings(o?.companies);
    });
  return steps && strings(g.certifications) && strings(g.skillGaps) && roles;
}

function readCache(key: string): GuidanceResult | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { key?: unknown; guidance?: unknown; source?: unknown };
    if (parsed.key !== key || !isGuidanceLike(parsed.guidance)) return null;
    return { guidance: parsed.guidance, source: parsed.source === "claude-cli" ? "claude-cli" : "heuristic" };
  } catch {
    return null;
  }
}

function writeCache(key: string, result: GuidanceResult): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ key, ...result }));
  } catch {
    // Private mode — revisits just re-fetch.
  }
}

function composeInputs(): { inputs: Inputs; fix: FixFirst | null } {
  const sessions = loadSessions();
  const scored = scoredSessions(sessions);
  const latest = scored[scored.length - 1];
  const fix = latestWeakest(sessions);
  // Stored role is user-editable JSON — validate against the preset enum.
  const lastAny = [...sessions].sort((a, b) => a.startedAt - b.startedAt).pop();
  const role: RolePreset = lastAny && ROLES.includes(lastAny.role) ? lastAny.role : "general";
  let resumeText: string | undefined;
  try {
    resumeText = window.sessionStorage.getItem("pds_resume") ?? undefined;
  } catch {
    // sessionStorage blocked — guidance still works from rounds alone.
  }
  return {
    inputs: {
      role,
      resumeText,
      performance: {
        avgScore: latest ? sessionAvg(latest) : null,
        weakestCriterion: fix?.criterion ?? null,
        sessionsCount: scored.length,
      },
    },
    fix,
  };
}

const keyFor = (i: Inputs) =>
  guidanceCacheKey(
    i.role,
    i.performance.sessionsCount,
    i.performance.avgScore,
    i.performance.weakestCriterion,
    i.resumeText,
  );

export default function GuidancePage() {
  const [inputs, setInputs] = useState<Inputs | null>(null);
  const [fix, setFix] = useState<FixFirst | null>(null);
  const [result, setResult] = useState<GuidanceResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGuidance = useCallback(async (i: Inputs) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/guidance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(i),
      });
      const d = (await res.json()) as { guidance?: unknown; source?: unknown; error?: unknown; message?: unknown };
      if (!res.ok) {
        const msg = typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : "guidance failed";
        throw new Error(msg);
      }
      if (!isGuidanceLike(d.guidance)) throw new Error("guidance failed");
      const r: GuidanceResult = {
        guidance: d.guidance,
        source: d.source === "claude-cli" ? "claude-cli" : "heuristic",
      };
      setResult(r);
      writeCache(keyFor(i), r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "guidance failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const composed = composeInputs();
    setInputs(composed.inputs);
    setFix(composed.fix);
    const cached = readCache(keyFor(composed.inputs));
    if (cached) {
      setResult(cached);
      setLoading(false);
      return;
    }
    void fetchGuidance(composed.inputs);
  }, [fetchGuidance]);

  const refresh = () => {
    if (inputs) void fetchGuidance(inputs);
  };

  const cold = inputs !== null && inputs.performance.sessionsCount === 0 && !inputs.resumeText;
  const g = result?.guidance;

  return (
    <main className="wrap">
      <h1>Your path from here</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        What to close, learn and aim for — built from your scored rounds
        {inputs?.resumeText ? " and your resume" : ""}.
      </p>
      {cold && <p className="small muted">Do a round or paste your resume and this sharpens.</p>}

      {loading && !g && (
        <div aria-hidden style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
          <div className="card tinted" style={{ height: 110 }} />
          <div className="card tinted" style={{ height: 190 }} />
        </div>
      )}

      {!loading && error && !g && (
        <div className="card tinted" style={{ marginTop: "var(--space-3)" }}>
          <p className="small muted" style={{ margin: 0 }}>
            Couldn&apos;t put your plan together — {error}
          </p>
          <button className="btn quiet" style={{ marginTop: 8 }} onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {g && (
        <>
          <section style={{ marginTop: "var(--space-4)" }}>
            <h2>Close these gaps first</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {g.skillGaps.map((s) => (
                <span className="chip" style={{ whiteSpace: "normal" }} key={s}>
                  {s}
                </span>
              ))}
            </div>
            {fix && (
              <p className="small muted" style={{ margin: "10px 0 0" }}>
                Latest round: {CRITERION_LABEL[fix.criterion]} was your weakest at {fix.score}/5
                {fix.evidence ? <> — “{fix.evidence}”</> : null}
              </p>
            )}
          </section>

          <section style={{ marginTop: "var(--space-4)" }}>
            <h2>Learning path</h2>
            <ol style={{ margin: 0, paddingLeft: 24, display: "grid", gap: "var(--space-2)" }}>
              {g.learningPath.map((step) => (
                <li key={step.skill}>
                  <span style={{ fontWeight: 600 }}>{step.skill}</span>
                  <span className="muted"> — {step.why}</span>
                  <br />
                  <span className="small muted">{step.resource}</span>
                </li>
              ))}
            </ol>
          </section>

          <section style={{ marginTop: "var(--space-4)" }}>
            <h2>Certifications worth having</h2>
            <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
              {g.certifications.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>

          <section style={{ marginTop: "var(--space-4)" }}>
            <h2>Roles that fit you</h2>
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              {g.roles.map((r) => (
                <div className="card" key={r.title}>
                  <div style={{ fontWeight: 600 }}>{r.title}</div>
                  <p className="small muted" style={{ margin: "4px 0 10px" }}>
                    {r.why}
                  </p>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {r.companies.map((c) => (
                      <span className="chip" key={c}>
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div style={{ marginTop: "var(--space-4)", display: "flex", alignItems: "center", gap: 10 }}>
            <button className="btn quiet" onClick={refresh} disabled={loading}>
              Refresh
            </button>
            {result?.source === "heuristic" && (
              <span className="small muted">generated locally · basic mode</span>
            )}
          </div>
        </>
      )}
    </main>
  );
}
