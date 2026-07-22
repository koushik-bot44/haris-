"use client";

// Shared stylesheet for the reporting + guidance surfaces (report, dashboard,
// history, progress, guidance). Built ON TOP of the Foundation systems in
// globals.css — it reuses .card / .chip / .btn / .pullquote / table.plain and
// only adds report-specific STRUCTURE under an r- namespace. Data-driven values
// (criterion hue, dot strength, bar width, SVG coords) stay inline because they
// come from the session, not the design. One <style> per page, server-rendered
// with the client component so there is no flash.

const CSS = `
/* ——— Page intro ——— */
.r-title { margin-bottom: var(--space-2); }
.r-lead { color: var(--muted); font-size: var(--fs-lead); line-height: 1.5; margin: 0 0 var(--space-4); max-width: 60ch; }
.r-lead.tight { font-size: var(--fs-body); margin-bottom: var(--space-3); }
.r-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0 0 var(--space-4); }
.r-clip { display: block; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
.r-block { margin: var(--space-3) 0; }
.r-section { margin: var(--space-5) 0 0; }
.r-section > h2 { margin-bottom: var(--space-3); }

/* ——— Verdict — always first in the report ——— */
.r-verdict { display: flex; flex-direction: column; gap: 14px; }
.r-verdict-score {
  font-family: var(--font-display, Georgia, serif);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: clamp(2.8rem, 8vw, 3.4rem);
  line-height: 0.95;
  letter-spacing: -0.02em;
  display: flex; align-items: baseline; gap: 4px;
}
.r-verdict-unit { color: var(--muted); font-size: 1.25rem; }
.r-verdict-summary {
  font-family: var(--font-display, Georgia, serif);
  font-style: italic; font-size: 1.12rem; line-height: 1.55;
  margin: 0; max-width: 62ch; color: var(--text);
}

/* ——— Stat rows (delivery metrics, GD counts) ——— */
.r-stats { display: flex; flex-wrap: wrap; gap: var(--space-3) var(--space-5); }
.r-stat { display: flex; flex-direction: column; gap: 3px; }
.r-stat-label { font-size: var(--fs-sm); color: var(--muted); }
.r-stat-val {
  font-variant-numeric: tabular-nums; font-weight: 600;
  font-size: 1.22rem; letter-spacing: -0.01em; color: var(--text);
}

/* ——— Score dots + criterion swatches (hue/strength inline) ——— */
.r-dots { display: inline-flex; gap: 6px; align-items: center; }
.r-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.r-swatch { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }

/* ——— Per-question cards ——— */
.r-qgrid { display: grid; gap: var(--space-2); }
.r-qhead { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); }
.r-qmeta { min-width: 0; }
.r-qnum { font-size: var(--fs-sm); color: var(--muted); font-variant-numeric: tabular-nums; }
.r-qtext { margin: 4px 0 0; font-weight: 600; font-size: 1.02rem; }
.r-qdots { flex-shrink: 0; align-self: center; }
.r-crit { display: grid; gap: var(--space-3); margin-top: var(--space-3); }
.r-crit-head { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); }
.r-crit-name { font-weight: 600; }
.r-crit-score { font-variant-numeric: tabular-nums; color: var(--muted); }
.r-tip { font-size: var(--fs-sm); margin: 6px 0 0; }
.r-attrib { font-style: normal; font-family: var(--font-ui, sans-serif); margin-top: 2px; }

/* ——— Replay scrubber ——— */
.r-scrub-row { display: flex; align-items: center; gap: 14px; margin: 0 0 var(--space-3); padding: 0 2px; }
.r-scrub {
  -webkit-appearance: none; appearance: none; background: transparent;
  height: 18px; margin: 0; cursor: pointer; flex: 1; min-width: 0;
}
.r-scrub:focus-visible { outline: none; }
.r-scrub::-webkit-slider-runnable-track {
  height: 4px; border-radius: 2px;
  background: linear-gradient(var(--text), var(--text)) left / var(--fill, 0%) 100% no-repeat, var(--surface-2);
}
.r-scrub::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--text); border: 2px solid var(--surface-raised);
  box-shadow: var(--shadow-sm); margin-top: -6px;
}
.r-scrub:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px oklch(20% 0.012 270 / 0.16); }
.r-scrub::-moz-range-track { height: 4px; background: var(--surface-2); border-radius: 2px; }
.r-scrub::-moz-range-progress { height: 4px; background: var(--text); border-radius: 2px; }
.r-scrub::-moz-range-thumb {
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--text); border: 2px solid var(--surface-raised); box-shadow: var(--shadow-sm);
}
.r-scrub-time { white-space: nowrap; font-variant-numeric: tabular-nums; }

/* ——— Transcript / replay timeline ——— */
.r-turns { display: grid; gap: 10px; }
.r-turn { padding: 11px 14px; border-radius: var(--radius-sm); border: 1px solid transparent; transition: border-color var(--t-fast) var(--ease-out); }
.r-turn.candidate { background: var(--surface); }
.r-turn.active { border-color: var(--text); }
.r-turn-head { font-size: var(--fs-sm); font-weight: 600; }
.r-turn-time { color: var(--muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.r-turn-text { margin: 4px 0 0; }
.r-mark { display: flex; align-items: center; gap: 6px; margin: 0 0 6px 14px; font-size: var(--fs-sm); color: var(--muted); }
.r-mark-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--live); flex-shrink: 0; }

/* ——— GD airtime ——— */
.r-airtime { position: relative; margin: 4px 0 34px; }
.r-airtime-bar { display: flex; gap: 2px; height: 12px; }
.r-airtime-seg { border-radius: 3px; }
.r-airtime-band {
  position: absolute; top: calc(100% + 4px); height: 5px;
  border-left: 1px solid var(--border-strong); border-right: 1px solid var(--border-strong);
  border-bottom: 1px solid var(--border-strong); border-radius: 0 0 2px 2px;
}
.r-airtime-band-label {
  position: absolute; top: calc(100% + 11px); text-align: center;
  white-space: nowrap; font-size: 0.72rem; color: var(--muted);
}
.r-airtime-legend { display: flex; gap: 6px 16px; flex-wrap: wrap; margin-bottom: var(--space-3); font-size: var(--fs-sm); }
.r-airtime-item { display: inline-flex; align-items: center; gap: 6px; }
.r-airtime-swatch { width: 9px; height: 9px; border-radius: 3px; display: inline-block; flex-shrink: 0; }
.r-airtime-pct { color: var(--muted); font-variant-numeric: tabular-nums; }

/* ——— Progress trend ——— */
.r-trend-legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; font-size: var(--fs-sm); }
.r-trend-item { display: inline-flex; align-items: center; gap: 6px; }
.r-right { text-align: right; }

/* ——— Dashboard fix-first ——— */
.r-fix-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.r-fix-title { font-weight: 600; font-size: 1.05rem; }
.r-fix-q { margin: 6px 0 0; }
.r-fix-tip { font-size: var(--fs-sm); margin: 12px 0 0; }
.r-summary { color: var(--muted); font-size: var(--fs-sm); margin: var(--space-3) 0 0; }
.r-summary strong { color: var(--text); font-variant-numeric: tabular-nums; }

/* Quiet arrow link, shared by the fix-first and guidance surfaces. */
.r-arrow {
  color: var(--muted); text-decoration: none; font-weight: 500; font-size: var(--fs-sm);
  display: inline-flex; align-items: center; gap: 5px;
  transition: color var(--t-fast) var(--ease-out), gap var(--t-fast) var(--ease-out);
}
.r-arrow:hover { color: var(--text); gap: 8px; }

/* ——— Guidance ——— */
.r-gaps { display: flex; gap: 8px; flex-wrap: wrap; }
/* Gap phrases are sentence-length — a pill radius turns a wrapped line into a
   blob, so wrapping chips take a tidy tag radius and left-aligned text. */
.chip.wrap {
  white-space: normal; text-align: left; line-height: 1.35;
  border-radius: var(--radius-sm); padding: 6px 12px; max-width: 100%;
}
.r-path { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
.r-step { display: flex; gap: var(--space-2); align-items: flex-start; }
.r-step-num {
  flex-shrink: 0; width: 27px; height: 27px; border-radius: 50%;
  border: 1px solid var(--border-strong); background: var(--surface-raised);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: var(--fs-sm); font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 1px;
}
.r-step-skill { font-weight: 600; }
.r-step-why { color: var(--muted); font-weight: 400; }
.r-step-resource { font-size: var(--fs-sm); color: var(--muted); margin-top: 3px; }
.r-certs { list-style: none; margin: 0; padding: 0; display: grid; gap: 9px; }
.r-certs li { position: relative; padding-left: 20px; }
.r-certs li::before {
  content: ""; position: absolute; left: 3px; top: 0.62em;
  width: 6px; height: 6px; border-radius: 50%; background: var(--border-strong);
}
.r-roles { display: grid; gap: var(--space-2); }
.r-role-title { font-weight: 600; }
.r-role-why { font-size: var(--fs-sm); color: var(--muted); margin: 4px 0 12px; }
.r-role-companies { display: flex; gap: 6px; flex-wrap: wrap; }
.r-actions { margin-top: var(--space-4); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.r-skeleton { display: grid; gap: var(--space-3); margin-top: var(--space-3); }

/* ——— History rows ——— */
.r-rowlink { cursor: pointer; transition: background var(--t-fast) var(--ease-out); }
.r-rowlink:hover { background: var(--surface); }
`;

export function ReportStyles() {
  return <style>{CSS}</style>;
}
