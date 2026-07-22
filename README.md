# Placement Day Simulator

Voice-first mock interviews for campus placements. You speak, an AI interviewer
listens, asks adaptive follow-ups, and (from weekend 2) hands you an
evidence-quoted scorecard with hard delivery metrics.

Final-year major project. The full reviewed plan lives in
`~/Documents/Hari's Project/Placement-Day-Simulator-Plan.pdf`.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000 — use Chrome (voice needs its speech API)
npm test           # unit tests: STT reducer, metrics, interview flow, API validation
```

No API key needed. Two brains, picked via `LLM_PROVIDER` (see `.env.example`):

- **`claude-cli`** (dev default via `.env.local`) — your authenticated Claude
  Code CLI runs the interviewer on the quickest model (haiku): a real,
  unscripted HR conversation that reacts to what you actually said. ~3–5s per
  reply (masked by the verbal ack); local machine only. Any CLI failure falls
  back to the scripted flow mid-interview — the round never dies.
- **`mock`** — scripted question bank, realistic latency, simulated failures
  (`LLM_MOCK_CHAOS=0` disables them). Used in CI and as the rescue path.

When a Gemini key exists: `LLM_PROVIDER=gemini` + the key in env — `lib/llm/`
is the only place that changes.

## Voices (pick on the setup screen)

- **System** — instant, robotic. The floor.
- **Kokoro (premium on-device)** — natural neural voice in the browser, free
  forever, ~80MB one-time download.
- **Chatterbox (studio, local)** — Resemble AI's MIT model (beat ElevenLabs
  63–65% in blind tests) served from `~/chatterbox-tts-server` on Apple MPS.
  Start it with `~/chatterbox-tts-server/run.sh`; the picker lights up when
  it's running. **Voice cloning:** open http://localhost:8004, upload a 5–10s
  clip, set `CHATTERBOX_VOICE` in `.env.local` to that file name.
- **ElevenLabs (cloud)** — needs `ELEVENLABS_API_KEY` (free signup tier).

Speech input auto-selects: Chrome's recognizer when reachable, on-device
Whisper (~40MB, any browser, offline) otherwise.

## What works today (v1.0.0.0 — the complete product)

- Every placement round: deep-dive HR and technical interviews (voice + text,
  Monaco coding pane), and the Group Discussion room — three AI candidates
  with distinct voices you fight for airtime, moderated and scored.
- A real interviewer: opens from your resume, probes each topic until you tap
  out, calls out rehearsed answers, nudges you when you stall, and can be
  interrupted mid-sentence. Replies are speculatively pre-generated while you
  speak, so they land near-instantly on the happy path.
- Studio voice: Chatterbox (Elena by default; pick Gianna/Adrian/Olivia on the
  setup screen) streamed sentence-by-sentence, falling back to on-device
  Kokoro, then the system voice — the room never goes silent.
- Evidence-based scoring: per-question rubric with quotes verifiably present
  in your transcript, delivery metrics, and a full report + replay timeline
  at /report/[id]; dashboard, history, and progress read the same data.
- Career guidance (/guidance): learning path, certifications, skill gaps, and
  role + company recommendations from your resume and scored rounds.
- PDF resume upload with in-browser extraction (the file never leaves your
  device) + ATS readiness score; guests never upload anything — sign-in and
  MongoDB persistence are optional and env-gated.

## Later (see TODOS.md)

Rubric scoring, report page hierarchy, rate limiting + deploy (weekend 2) ·
GD spike (August, weekends 3–4) · technical round + resume context (M2) ·
auth + dashboard (M3) · GD room / replay (M4–M5).

## Layout

```
app/                 pages + /api/interview (zod-hardened, provider-backed)
lib/stt-reducer.ts   restart/degrade policy — pure, tested with scripted events
lib/stt.ts           thin browser adapter around the reducer
lib/tts.ts           speechSynthesis: voices race, sentence chunking
lib/metrics.ts       delivery metrics from the event trace
lib/llm/             provider abstraction (mock today, gemini later)
lib/fixtures/        curated HR question bank + persona lines
hooks/               useInterviewMachine — the room's state machine
test/                vitest suites for everything above
```
