# Placement Day Simulator

A voice-first, AI-powered interview preparation and placement assistant, built
with Generative AI. You speak, an AI interviewer listens, reads your resume,
probes each topic until you tap out, and hands you an evidence-quoted scorecard
with real delivery metrics. HR round, technical round with a live coding editor,
and a Group Discussion room where three AI candidates debate you for airtime.

Final-year major project. Runs entirely on your own machine.

---

## Quick start (for teammates cloning this repo)

You need **Node.js 18 or newer** and **Google Chrome** (voice input uses Chrome's
speech API). Check with `node --version`.

```bash
# 1. Install dependencies (one time, ~1 minute)
npm install

# 2. Start the app
npm run dev

# 3. Open it in Chrome
#    http://localhost:3000
```

That's it — the app runs with **no API key and no setup**. Out of the box you get
the full interface, scripted interview questions, on-device voice, and a working
scorecard. To unlock the *adaptive* AI interviewer (questions generated live from
your answers), add a free Groq key — see **"Make it smart"** below.

> **Sharing with your team:** each person clones the repo and runs
> `npm install && npm run dev` on their own laptop. Everyone gets their own
> `http://localhost:3000`. No server, no deploy, no shared account needed.

---

## Make it smart (free, ~2 minutes) — optional but recommended

Without a key, the interviewer asks good scripted questions. With a free **Groq**
key, it becomes a real adaptive interviewer: it reads your resume, reacts to your
exact words, drills deeper, and replies in under a second.

1. Get a free key at **https://console.groq.com** → *API Keys* → *Create key*.
2. Create a file named `.env.local` in the project root (copy `.env.example`):

   ```bash
   cp .env.example .env.local
   ```

3. Open `.env.local` and set:

   ```
   LLM_PROVIDER=groq
   GROQ_API_KEY=gsk_your_key_here
   GROQ_MODEL=llama-3.3-70b-versatile
   ```

4. Restart the app (`Ctrl-C`, then `npm run dev` again).

> `.env.local` is **git-ignored** — your key never gets committed or shared.
> Each teammate uses their own free Groq key (the free tier is generous).

**Model choice:** `llama-3.3-70b-versatile` (default, best quality) or
`llama-3.1-8b-instant` (fastest, ~0.25s replies).

---

## Voices (pick on the setup screen)

The app never goes silent — it picks the best available voice and falls back
automatically:

- **On-device (Kokoro)** — natural neural voice, runs in the browser, free
  forever, ~80MB one-time download. **This is what teammates get by default.**
- **System** — instant, robotic. The always-available floor.
- **Studio (Chatterbox, local, optional)** — a studio-grade neural voice that
  runs on your own machine (Apple Silicon / NVIDIA GPU). Only needed if you want
  the premium voice or voice cloning. Set up separately (see below).
- **Cloud (ElevenLabs, optional)** — add `ELEVENLABS_API_KEY` to `.env.local`.

Speech **input** auto-selects: Chrome's recognizer when available, on-device
Whisper (~40MB, works in any browser, offline) otherwise.

### Studio voice setup (optional, advanced)

The premium "Elena" studio voice comes from a local Chatterbox TTS server. It's
optional — teammates without it get the on-device Kokoro voice, which is still
good. To run it, install [Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server),
start it on port 8004, and add to `.env.local`:

```
CHATTERBOX_URL=http://127.0.0.1:8004
CHATTERBOX_VOICE=Elena.wav
```

The voice picker on the setup screen lights up when the server is running.

---

## Tips for a good session

- **Use headphones** if you can — it stops the AI's own voice from being picked
  up by your microphone. (The app filters most echo, but headphones are cleaner.)
- Allow microphone access when Chrome asks. If you deny it or your mic fails, the
  app switches to **text mode** automatically — the interview still works.
- Paste or upload your resume on the setup screen for personalized questions.
- Technical round = DSA + coding questions, with a real code editor at question 3
  in the language you pick (Java, Python, C++, JavaScript, or C).

---

## What's inside (all 10 department modules + more)

- **HR & Technical interviews** (voice + text) — adaptive, resume-anchored,
  deep-dive questioning; technical round is DSA + a live coding editor.
- **Group Discussion room** — three AI debater personas with distinct voices,
  a moderator, barge-in, and airtime scoring. No other tool simulates this.
- **AI resume analysis** — ATS readiness score, strengths, gaps, missing skills.
- **Evidence-based scoring** — per-question rubric where every quote is verified
  to actually appear in your transcript (a hallucination guard).
- **Report + replay** — a scrubbing timeline of your whole interview.
- **Dashboard, history, progress** — your scored rounds over time.
- **Career guidance** — learning path, certifications, and job/company
  recommendations built from your resume and performance.
- **Login (optional)** — Google sign-in + MongoDB persistence are env-gated;
  guests work fully in the browser with nothing uploaded.

**The Generative AI:** an LLM generates every interview question, the scoring,
the resume analysis, the guidance, and the debate; a neural TTS model generates
the voice; Whisper generates the transcription. Every path has a deterministic
fallback so a model outage never kills a session. See
`docs/department-module-crosscheck.md`.

---

## Running the project — every command explained

Run these from the project root (the folder with `package.json`).

| Command | What it does | When to use it |
|---------|--------------|----------------|
| `npm install` | Downloads all dependencies into `node_modules/`. Run once after cloning, and again whenever `package.json` changes. | First thing after `git clone`. |
| `npm run dev` | Starts the app in development mode at **http://localhost:3000** with hot-reload (edits show up instantly). | Day-to-day use and demos. |
| `npm run build` | Compiles an optimized production build into `.next/`. | Before deploying, or to check the app compiles cleanly. |
| `npm start` | Serves the production build (run `npm run build` first). Faster than dev mode. | Running the finished app. |
| `npm test` | Runs the full test suite (344 unit tests) once and exits. | Verifying nothing is broken. |
| `npm run test:watch` | Runs tests and re-runs them automatically as you edit. | While writing or fixing code. |

### The normal flow for a teammate

```bash
git clone https://github.com/koushik-bot44/haris-.git
cd haris-
npm install          # one time, ~1 minute
npm run dev          # then open http://localhost:3000 in Chrome
```

Press **Ctrl-C** in the terminal to stop the server.

## Troubleshooting (if you get an error)

- **`command not found: npm`** — Node.js isn't installed. Install it from
  [nodejs.org](https://nodejs.org) (the LTS version), then reopen your terminal.
- **`npm install` fails or is slow** — check your internet, then try again. If it
  still fails, delete `node_modules/` and `package-lock.json` and re-run
  `npm install`.
- **`Error: Port 3000 is already in use`** — another app is on that port. Either
  stop it, or run on a different port: `npm run dev -- -p 3001` (then open
  `http://localhost:3001`).
- **The interviewer gives generic/scripted questions** — that's the no-key mode.
  Add a free Groq key (see "Make it smart" above) for the adaptive AI interviewer.
- **No microphone / mic denied** — the app automatically switches to **text mode**;
  the interview still works, you just type your answers. To use voice, allow the
  mic when Chrome asks (or click the address-bar lock icon → Microphone → Allow).
- **Voice sounds robotic** — the premium studio voice needs the optional local
  Chatterbox server. Without it you get the on-device Kokoro voice, which is still
  natural — it just takes ~80MB to download the first time.
- **The AI voice keeps getting cut off** — leave the "Let me interrupt the
  interviewer" box **unchecked** on the setup screen (it's off by default). Only
  turn it on if you're wearing headphones.
- **Use Google Chrome** — voice input uses Chrome's speech API. Other browsers
  fall back to on-device Whisper, which works but is slower to start.

## Project layout

```
app/                 pages + API routes (/api/interview, /score, /gd, /tts, ...)
hooks/               useInterviewMachine, useGdMachine — the room state machines
lib/llm/             the AI brains: groq (production), claude-cli (dev), mock,
                     plus scoring, resume analysis, guidance
lib/resume-profile.ts  resume → skills/projects/experience (pure, instant)
lib/stt*.ts          speech-to-text (Chrome + on-device Whisper), pure reducer
lib/tts.ts           streaming voice playback + engine fallback chain
lib/gd/              Group Discussion engine (personas, debate flow, airtime)
lib/fixtures/        curated question banks (HR, DSA, coding in 5 languages)
test/                vitest suites for everything above
```
