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

## What works today (M1 weekend 1)

- Full spoken HR round: mic check → pre-roll → 5 questions with adaptive
  follow-ups → wrap-up, all questions spoken aloud and captioned.
- STT hardening: Chrome's recognizer auto-stops and errors constantly; the
  wrapper (pure reducer, fully unit-tested) restarts it and preserves the
  transcript. Mic denial or repeated network errors degrade to text mode —
  the interview never dies.
- Delivery metrics: pace, lexical fillers, long pauses — computed from the
  recorded STT event trace with restart gaps excluded.
- Visible latency number per turn (student's last word → interviewer's first
  syllable), plus the verbal-acknowledgment mask.
- Guest sessions saved to localStorage in the same schema MongoDB gets later.

## Not yet (by design — see the plan)

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
