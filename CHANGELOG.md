# Changelog

All notable changes to the Placement Day Simulator.

## [1.0.0.0] - 2026-07-22

**The complete product: every placement round, a real interviewer, and a studio voice.**
**Reviewed by an eight-reviewer army, QA'd live end-to-end at 96/100.**

This release takes the simulator from a working voice loop to the full Placement Day experience. The interviewer now behaves like a real hiring interviewer: she opens from your resume, drills each topic until you tap out, calls out rehearsed answers, and switches gears gracefully. Her voice is Elena from the local Chatterbox studio engine, streamed so the first syllable plays while the rest is still synthesizing. The Group Discussion room is live: three AI candidates with distinct voices debate you for airtime while a moderator keeps order. Every round lands in a full report with a replay timeline, and a new Guidance page turns your scored rounds into a learning path with real certifications and companies.

### The numbers that matter

Source: this repo's test suite (`npx vitest run`), the pre-landing review log (`~/.gstack` review entries, 2026-07-22), and the live QA report (`.gstack/qa-reports/qa-report-localhost-2026-07-22.md`).

| Metric | Before | After |
|--------|--------|-------|
| Unit tests | 59 | 265 |
| Department modules live | 8 of 10 | 10 of 10 (+ the GD room no tool has) |
| Review findings found → fixed | — | 52 → 41 (rest deferred with reasons) |
| Live QA health score | — | 96/100, full round E2E |
| TTS first audio (streaming, short line) | full synth wait | ~3.3s buffered, first chunk earlier when streamed |

The QA round was a real interview: the AI probed the candidate's project, caught an "I don't know" tap-out, pushed back on a rehearsed answer, and produced a scorecard whose every evidence quote verifiably appears in the transcript.

### What this means for you

Open the app, pick a round, and rehearse the real thing: an interviewer who thinks, a debate you have to fight your way into, and a report that tells you exactly what to fix next — all free, all on your machine. When you buy an API key later, one env var swaps the brain; nothing else changes.

### Itemized changes

#### Added
- Group Discussion room (`/gd`): moderator Anita plus three debater personas with distinct Chatterbox voices and orb colors; barge-in by voice or hold-SPACE; live airtime meter with the 20–35% target band; scored on airtime share and interjection quality.
- Full report and replay page (`/report/[id]`): verdict, delivery metrics, per-question evidence pull-quotes, and a scrubbing replay timeline of the whole conversation; history rows link into it.
- Career guidance (`/guidance`): learning path, certification recommendations, skill-gap analysis, and role + company suggestions built from your resume and scored rounds, with a curated offline fallback.
- PDF resume upload with in-browser text extraction — the file never leaves your device — plus an ATS readiness score (0–100), missing skills, and improvement suggestions.
- Deep-dive interviewer brain: ~5 resume-first topics probed concept → application → tradeoffs → what-if until tap-out; expressive speech tags ([chuckle], [sigh]) via the Turbo voice model, stripped from captions.
- Conversation dynamics: silence nudges ("Take your time…"), thin-answer invites ("Mm-hm — go on?"), rephrase offers, and give-up handling — the interviewer reacts like a person when you stall.
- Speculative instant replies: the next question and its audio are pre-generated while you're still answering; the opening greeting is pre-warmed during the pre-roll.
- Streaming Chatterbox playback with per-voice casting (Elena default; Gianna, Adrian, Olivia curated in the setup picker) and an honest engine-fallback chain (chatterbox → on-device → system).
- Env-gated platform layer: MongoDB session persistence, Google sign-in, and rate limiting (Upstash or in-memory) — all dormant with zero config; guest mode is untouched and guests never upload.
- Light-studio redesign across every screen: OKLCH tokens, Schibsted Grotesk + Newsreader, app shell navigation, choice-card pickers, criterion-colored data viz, full keyboard support for the custom controls.

#### Changed
- The interview is a real-time conversation everywhere: mic stays live during interviewer speech, and the room, report, and dashboard all read from the same session store the moment a round ends.
- History labels all three round types and links each row to its report; progress chart is responsive with date labels.

#### Fixed
- 41 review findings including: refused requests draining the shared daily quota; an unthrottled session-write endpoint; the local LLM subprocess running with tools enabled (now hard-locked); a GD race where personas ignored the candidate's latest point; a live-microphone leak; a 6000-character answer bricking the round; airtime math counting synthesis latency against the candidate; and the guest privacy promise (transcripts now never leave the device unless you sign in).
