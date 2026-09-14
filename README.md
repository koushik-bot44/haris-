# Placement Day Simulator

A voice-first, AI-powered interview preparation and placement assistant. You
speak; an AI interviewer listens, reads your resume, probes each topic until
you tap out, and hands you an evidence-quoted scorecard with real delivery
metrics. HR round, technical round with a live coding editor, and a Group
Discussion room where three AI candidates debate you for airtime.

It talks back **in real time**: the reply streams from the model, every
sentence is spoken the moment it closes (while the rest is still being
written), and you can interrupt mid-sentence like a person.

---

## Quick start

You need **Node.js 20.3 or newer** (`node --version`). Chrome gives the best
voice experience; every other browser works too (see *Hearing* below).

```bash
git clone https://github.com/koushik-bot44/haris-.git
cd haris-
npm install                # one time, ~1 minute
cp .env.example .env.local # then put ONE key in it — see below
npm run dev                # http://localhost:3000
```

Press **Ctrl-C** in the terminal to stop the server.

With **no key at all** the app still runs end to end: scripted interviewer,
on-device voice, Chrome speech recognition. That mode is for demos without a
network; it is not the product.

## The one key that makes it real (free)

Get a free key at **https://console.groq.com** → *API Keys*, and put it in
`.env.local`:

```
GROQ_API_KEY=gsk_...
```

That single key gives you all three parts of a live conversation:

| Part | What Groq provides | Latency |
|------|--------------------|---------|
| Brain | `openai/gpt-oss-120b` chat (falls back to `gpt-oss-20b` when rate-limited; if a model is missing on your account the server picks one you do have from `/models` and says so in the log) | first token ≈ 0.3 s |
| Voice | Orpheus text-to-speech, streamed sentence by sentence — **needs a one-time terms acceptance** at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english (until then the on-device voice speaks) | first audio ≈ 0.5 s after the first sentence closes |
| Hearing | Whisper `large-v3-turbo` transcription for browsers without a built-in recognizer | ≈ 0.3 s per utterance |

Restart `npm run dev` after editing `.env.local`, then open
**http://localhost:3000/api/health** — it lists exactly which brain, voice and
speech engines the server sees (never the keys).

### Better voices (optional)

Add any of these and the server picks the best one automatically (or force one
with `TTS_PROVIDER=`):

| Key | Engine | Notes |
|-----|--------|-------|
| `ELEVENLABS_API_KEY` | ElevenLabs `eleven_flash_v2_5` | best quality, ~75 ms model latency, streamed PCM |
| `OPENAI_API_KEY` | `gpt-4o-mini-tts` (also usable as the brain: `LLM_PROVIDER=openai`) | persona-styled delivery |
| `DEEPGRAM_API_KEY` | Aura-2 (also unlocks **live streaming recognition** — see Hearing) | |
| `GEMINI_API_KEY` | Gemini TTS (also usable as the brain) | |

Every persona keeps its own voice on every engine (`lib/voice-cast.ts`): the
interviewer and the four GD participants never share one.

With no cloud voice at all the interviewer still speaks — with the on-device
Kokoro voice once its one-time ~90 MB download finishes (the room waits for it
before starting). The engine that actually spoke is shown in the room
("Cloud voice" / "On-device voice" / "Basic voice"); nothing is ever silent.

### Hearing (speech-to-text)

Chosen automatically, best first, with a per-visit fallback when one fails:

1. **Deepgram live** (`DEEPGRAM_API_KEY`) — true streaming recognition with
   interim words in any browser; the browser gets a 60-second token from
   `/api/stt/token`, never the key.
2. **Chrome's built-in recognizer** — free, real-time, needs Google's speech
   service reachable (Brave/Arc/Chromium builds and some VPNs block it).
3. **Cloud transcription** (`GROQ_API_KEY` / `OPENAI_API_KEY` / `DEEPGRAM_API_KEY`)
   — utterances are cut on-device by a VAD and transcribed in ~300 ms. Works
   in Firefox, Safari, everything.
4. **On-device Whisper** — ~40 MB download, fully offline.
5. **Text mode** — always available; questions are still spoken and captioned.

### Other brains

| Env | Backend |
|-----|---------|
| `OPENAI_API_KEY` (+ `OPENAI_MODEL`, default `gpt-5.6-luna`) | OpenAI |
| `GEMINI_API_KEY` (+ `GEMINI_MODEL`, default `gemini-2.5-flash`) | Gemini, via its OpenAI-compatible endpoint |
| `OPENROUTER_API_KEY` (+ `OPENROUTER_MODEL`) | OpenRouter |
| `LLM_PROVIDER=custom` + `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` | any OpenAI-compatible server (Ollama, vLLM…) |
| `LLM_PROVIDER=claude-cli` | your authenticated Claude Code CLI (development only) |
| `LLM_PROVIDER=mock` | the scripted question bank |

The first key found wins unless `LLM_PROVIDER` says otherwise. Scoring, resume
analysis, career guidance and the GD debate run on a separate background model
(`qwen/qwen3.6-27b` on Groq) so they never spend the interviewer's token budget.

---

## What's inside (all 10 department modules + more)

- **HR & Technical interviews** (voice + text) — adaptive, resume-anchored,
  deep-dive questioning; the technical round includes a live coding editor.
- **Adaptive interview engine** (`lib/interview/`) — the app owns the plan,
  evidence, competency coverage, claims and scoring; the model writes the words
  and proposes one move (follow up, clarify, challenge, probe a resume claim,
  adjust difficulty, switch competency, test a contradiction, wrap), which the
  server validates before anything is spoken. Progress is driven by evidence
  coverage, contradictions are raised with the candidate's own quotes, state
  travels as a signed token, and a model outage falls back to a deterministic
  interviewer that makes the same adaptive moves. Rounds end with a readiness
  verdict (READY / ALMOST READY / NEEDS PRACTICE / NOT READY).
- **Group Discussion room** — three AI debater personas with distinct voices,
  a moderator, barge-in, and airtime scoring.
- **AI resume analysis** — ATS readiness score, strengths, gaps, missing skills.
- **Evidence-based scoring** — every quote in your scorecard is verified to
  actually appear in your transcript (a hallucination guard).
- **Report + replay** — a scrubbing timeline of your whole interview.
- **Dashboard, history, progress** — your scored rounds over time.
- **Career guidance** — learning path, certifications, and job/company
  recommendations built from your resume and performance.
- **Login (optional)** — email/password or Google sign-in with MongoDB
  persistence, all env-gated; guests work fully in the browser.

**The Generative AI:** an LLM generates every interview turn, the scoring, the
resume analysis, the guidance, and the debate; a neural TTS model generates the
voice; Whisper generates the transcription. Every path has a deterministic
fallback so a model outage never kills a session. See
`docs/department-module-crosscheck.md`.

---

## Tips for a good session

- **You can interrupt the interviewer** — just start talking. It is on by
  default; turn it off on the preroll screen in a noisy room or on a shared desk.
  Headphones give the cleanest audio.
- A short pause ends your answer. Trailing off mid-sentence ("and… um…") buys
  you longer, and saying "that's it" hands the turn back immediately; **Enter**
  or the button works too. The interviewer nudges you if you go quiet and
  re-asks in simpler words after a silent window.
- Paste or upload your resume for questions anchored to *your* projects. The
  PDF is parsed in the browser; the extracted text (and your answers) are sent
  to the AI provider — leave out phone numbers and addresses.
- Technical round = your background → one project in depth → a coding
  exercise in a real editor (Java, Python, C++, JavaScript, C) → a review of
  your code → CS fundamentals → your questions.

---

## Production deployment

`NODE_ENV=production` **refuses to boot** without a proper session secret;
everything else degrades gracefully and is reported by `/api/health`.

```
AUTH_JWT_SECRET=<openssl rand -hex 32>       # required
GROQ_API_KEY=...                              # the brain (+ voice + hearing)
MONGODB_URI=mongodb+srv://...                 # accounts + server-side history (required for sign-up on serverless)
UPSTASH_REDIS_REST_URL=... / _TOKEN=...       # cross-instance rate limits (recommended on serverless)
ELEVENLABS_API_KEY / DEEPGRAM_API_KEY / ...   # optional better voice / live hearing
```

- Works on Vercel (Node.js middleware, `maxDuration` set on the streaming
  routes) and on any Node host (`npm run build && npm start`). On Vercel pick
  Node **22.x or 24.x** (20 is deprecated there from 2026-10-01) and set only
  `AUTH_JWT_SECRET` + `GROQ_API_KEY`; the on-device Kokoro voice is the
  production voice. Step-by-step, the plan limits this app touches, and how to
  prove a deploy landed: `docs/DEPLOYMENT.md`.
- Behind a reverse proxy, forward `X-Forwarded-For` so per-IP limits work;
  without it the per-client cookie limits still apply.
- Serving a production build over plain HTTP on a LAN? Set
  `AUTH_COOKIE_SECURE=0` or nobody can sign in.
- Security headers (HSTS, nosniff, frame denial, microphone-only permissions
  policy) are set in `next.config.ts`.
- Rate limits: per-client per-minute buckets on every costed route, a per-IP
  ceiling, brute-force protection on login/register, and a **per-client**
  daily LLM budget (400 calls) plus a per-IP daily ceiling — no single client
  can switch the interviewer off for everyone.

### Health check

`GET /api/health` → `{ ok, llm, tts, stt, db, rateLimit, auth, warnings, errors }`.
If the interviewer sounds scripted, this is the first place to look.

---

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Development server with hot reload at http://localhost:3000 |
| `npm run build` / `npm start` | Production build / serve it |
| `npm test` | The unit test suite (vitest) |
| `npm run test:watch` | Re-runs the tests as you edit |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | typecheck + build + tests — what CI should run |

## Troubleshooting

- **`command not found: npm`** — Node.js isn't installed. Install the LTS from
  [nodejs.org](https://nodejs.org), then reopen your terminal.
- **`npm install` fails** — check your connection and retry; if it still fails,
  delete `node_modules/` and run `npm install` again.
- **The interviewer asks generic/scripted questions** — no brain key is set,
  or the key is wrong. `GET /api/health` says which; the server log says why
  each scripted fallback fired (`[interview] scripted fallback — …`).
- **No voice** — check `/api/health` `tts`. With no cloud key the on-device
  Kokoro voice downloads once (~90 MB) before the round starts. The room's chip
  shows the engine that actually spoke.
- **Mic denied / recognizer unavailable** — the room switches to text mode and
  explains the exact fix; "Try microphone again" re-arms voice through the
  next best engine (cloud transcription if a key exists, else on-device).
- **Use Google Chrome** for the smoothest voice input; other browsers fall back
  to cloud or on-device transcription, which works but starts slower.
- **`Port 3000 is already in use`** — `npm run dev -- -p 3001`.
- **Production refuses to start** — read the `[env] FATAL:` line: it names the
  missing variable.

## Project layout

```
app/                 pages + API routes (/api/interview, /tts, /stt, /score, /gd, /health, ...)
hooks/               useInterviewMachine, useGdMachine — the room state machines
lib/llm/             chat.ts (one OpenAI-compatible transport for every backend),
                     api-provider.ts (the interviewer brain), complete.ts (background brains),
                     scoring, resume, guidance
lib/tts.ts           client playback: streaming, jitter buffer, never-silent fallback chain
lib/speech-queue.ts  sentence pipelining (speak sentence N while N+1 synthesizes)
lib/tts-engines.ts   server voices: ElevenLabs / OpenAI / Deepgram / Groq / Gemini → streaming WAV
lib/stt*.ts          hearing: Deepgram live, Chrome, cloud transcription, on-device Whisper
lib/voice-cast.ts    persona → voice on every engine
lib/gd/              Group Discussion engine (personas, debate flow, airtime)
lib/interview/       adaptive engine: plan, analysis, coverage, claims, moves, fallback, report, signed state
lib/fixtures/        curated question banks (HR, DSA, coding in 5 languages)
docs/                DEPLOYMENT.md, E2E_VERIFICATION.md, PRODUCTION_PLAN.md
test/                vitest suites
```
