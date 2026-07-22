# TODOS — Placement Day Simulator

## Deferred from the 2026-07-22 review + QA (minor, non-blocking)

- [ ] Cross-tab localStorage merge (M, P2) — `saveSession` is last-write-wins across two tabs finishing near-simultaneously; needs a merge-on-write strategy. Rare in practice (one candidate, one tab).
- [ ] Consolidate the stat-row render pattern shared by `DeliveryRow` and `GdMetricsPanel` (S, P3) — harmless duplication.
- [ ] Consolidate the round→persona-first-name mapping (fixtures / report-utils / claude-cli prompt) into one source (S, P3).
- [ ] Silence the webpack `import.meta` warning from the kokoro-js dependency (S, P3) — dev-console noise only.
- [ ] Interviewer turn latency: the dev Claude-CLI bridge runs 10-30s under account throttling (QA ISSUE-001). Resolves by adding the API provider (`LLM_PROVIDER=gemini` or OpenRouter) in `lib/llm/` when a key is purchased — the slot is ready.

## Deferred delight tier (from the approved plan, post-M3)

- [ ] Shareable scorecard image (S, P3) — social share of a session scorecard; virality lever. Depends: report page (now built).
- [ ] Interviewer personality picker (S, P3) — strict/friendly HR presets on the setup screen.
- [ ] Practice streaks / reminders (S, P3) — retention mechanics; irrelevant pre-launch.
- [ ] PDF export for placement cell (S, P3) — institutional distribution angle; post-validation.
- [ ] Question-of-the-day from real company rounds (M, P3) — needs question-bank growth first.
- [ ] Cinematic landing intro (S, P3) — builder's strength; replay page shipped first, this rides later.
- [ ] Email delivery (scorecard-to-inbox, weekly digest) via Resend free tier — evaluate post-M3.

## Human calendar work (not code)

- [ ] Evaluation study (n=15–20 batchmates, blind comparison vs peer ratings) — Dec/Jan window per plan.
- [ ] Campus distribution (October) — share the public URL during peak placement season; needs a deploy first.
- [ ] Guide meeting: confirm documentation format; walk the tiered module table.
- [ ] Deploy to Vercel + create the GitHub repo (no remote exists yet) — /ship will flag this.
