# Department Module Cross-Check — v1.0.0.0 (2026-07-22)

The official 10-module spec ("AI Powered Interview Preparation and Placement Assistant Using Generative AI") versus what is actually built, with the viva defense for every deliberate difference.

## Module-by-module

| # | Spec module | Status | Where it lives / the delta |
|---|-------------|--------|---------------------------|
| 1 | User Authentication (bcrypt + JWT) | **BUILT, deliberately different** | Google sign-in via NextAuth v5 (`lib/auth.ts`), env-gated. NextAuth issues JWTs internally; hand-rolled bcrypt password storage was rejected in eng review as the classic student vulnerability. Guest mode works with zero login — sign-in gates only saved history. **Viva line:** "We deliberately avoided storing passwords at all — delegated auth is the industry default." |
| 2 | Resume Upload (PDF, Multer) | **BUILT, stronger** | PDF upload with **in-browser** extraction (`lib/resume-extract.ts`, pdfjs) — the file never leaves the device, no Multer server storage needed. Paste also works. **Viva line:** "Extraction happens client-side — better privacy than uploading the PDF to a server." |
| 3 | Resume Text Extraction (pdf-parse) | **BUILT** | Same module as #2 — pdfjs text extraction feeding the same resume field the interviewer reads. |
| 4 | AI Resume Analysis (ATS score, strengths, weaknesses, missing skills, improvements) | **BUILT** | `/api/resume-analysis`: ATS readiness 0–100, strengths, gaps an interviewer will probe, talking points, missing skills, improvements. Deterministic fallback when the LLM is offline. |
| 5 | AI Interview (HR/Technical, dynamic questions) | **BUILT, far beyond spec** | Voice-first with streaming studio TTS, deep-dive topic probing until tap-out, barge-in mid-sentence, silence nudges, speculative instant replies, Monaco coding pane in the technical round, text mode as a first-class fallback. |
| 6 | Answer Evaluation (score + feedback + stored progress) | **BUILT, beyond spec** | Per-answer rubric (4 criteria × 1–5) with evidence quotes **programmatically verified against the transcript**, coach-tone tips, delivery metrics (pace, fillers, pauses), background scoring so results are warm at wrap-up. |
| 7 | Interview Report | **BUILT, beyond spec** | `/report/[id]`: verdict, delivery row, per-question cards, and a scrubbing **replay timeline** of the whole conversation. |
| 8 | Dashboard (ATS, history, analytics, readiness) | **BUILT** | Fix-first dashboard + history (score-dot rows) + progress (4-criteria trend chart); ATS score lives on the setup analysis card. |
| 9 | Career Guidance (learning paths, certifications, skill-gap) | **BUILT** | `/guidance`: ordered learning path, real certifications, skill gaps led by your actual weakest criterion, curated per-role fallback. |
| 10 | Job Recommendation (roles + companies) | **BUILT** | Same `/guidance` page: 2–4 fitting roles, each with real India-hiring companies (no fabrication — allowlisted well-known names). |

**Score: 10/10 modules present.** Two are deliberately different from the spec's implementation notes (#1 auth mechanism, #2/#3 extraction location) — both differences are defensible upgrades, documented above.

## Tech-stack deltas (spec → built)

| Spec | Built | Why |
|------|-------|-----|
| React + Material UI | Next.js 15 (React 19) + a custom design system | One deployable app; Material UI reads as template — the light-studio system is a portfolio differentiator |
| Node + Express | Next.js API routes + middleware | Same Node backend, fewer moving parts, free Vercel deploy path |
| MongoDB Atlas | MongoDB Atlas (env-gated, wired) | Add `MONGODB_URI` and it's live; guests stay local-first |
| OpenRouter LLM | Local Claude CLI now; provider slot ready | `lib/llm/` provider abstraction — OpenRouter/Gemini drops in with one env var when the API key is purchased |
| JWT + bcrypt | NextAuth (JWT sessions, Google) | No password storage; see module 1 |
| Multer + pdf-parse | In-browser pdfjs | See modules 2–3 |

## Beyond the spec (nothing else has these)

1. **The Group Discussion room** — 3 AI debater personas + a moderator, distinct voices, barge-in by voice or SPACE, live airtime meter, scored on airtime share and interjection quality.
2. **Verified evidence quotes** — every scorecard quote is substring-checked against the transcript; fabrications are dropped, never rendered.
3. **Replay timeline** — scrub through the entire interview with per-turn timestamps.
4. **Real-time conversation** — the mic stays live while the interviewer speaks; interrupt her like a person.
5. **Speculative instant replies + streaming TTS** — the next question and its audio are prepared while you're still answering.
6. **Delivery metrics** — pace, fillers, hesitations, longest pause, computed on-device.
7. **Full quality pipeline on record** — 8-reviewer pre-landing review (52 findings, 41 fixed), live QA at 96/100, 265 unit tests, all in this repo's history.

## Where the Generative AI is (the project title's "Using Generative AI", mapped)

Every module runs on generative models — nothing here is a lookup table wearing an AI costume:

| Surface | Generative model at work | What it generates |
|---|---|---|
| Interview questions (HR + Technical) | Large language model (Claude family via local CLI; OpenRouter/Gemini slot ready) | Every adaptive question and follow-up is generated live from YOUR resume and YOUR previous answers — the deep-dive probes react to exact wording, which no scripted system can do |
| Answer evaluation | LLM (sonnet-class) | Rubric scores, evidence selection, and coach-tone improvement tips — generated per answer, then the quotes are programmatically verified against the transcript (a hallucination guard on top of generation) |
| Resume analysis + ATS | LLM | Strengths, probe-points, talking points, missing skills, improvements — generated from the resume text |
| Career guidance + job recommendations | LLM | Learning path, certification picks, skill-gap analysis, role/company fits |
| Group Discussion debaters | LLM (batched multi-persona generation) | Three distinct debate personas + a moderator generating argument turns that respond to the candidate's points |
| The interviewer's voice | **Generative neural TTS** (Resemble AI Chatterbox — 0.5B-parameter speech model, MIT-licensed) | The speech waveform itself is generated, sentence by sentence, streamed; supports zero-shot voice cloning and paralinguistic generation ([chuckle], [sigh]) |
| Speech recognition | Neural sequence model (OpenAI Whisper on-device, when Chrome's service is unavailable) | Transcription via a generative encoder-decoder transformer |

**Viva one-liner:** "The system composes four generative models — an LLM for reasoning and dialogue, a diffusion-class neural TTS for speech, Whisper for recognition — with a deterministic verification layer on top, because generative output must be trusted only after checking: every evidence quote is verified against the transcript before a student sees it."

Engineering honesty that examiners reward: the system also carries **deterministic fallbacks** for every generative path (scripted question banks, heuristic scoring, curated guidance) so a model outage never kills a session — that's a generative-AI *architecture* decision, not a lack of generative AI.

## Remaining (tracked in TODOS.md)

Deploy to Vercel + create the GitHub repo (no remote yet), swap in the paid LLM API when purchased, the evaluation study and campus distribution (calendar work), and the deferred delight tier.
