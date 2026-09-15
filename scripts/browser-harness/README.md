# Browser voice-session harness

Drives the interview room in a real Google Chrome (headless) with a fake
microphone, so the whole voice loop runs: VAD → `/api/stt` → engine → `/api/tts`
or the on-device voice → playback. Used for the 2026-09 repetition / STT-failure
validation (see `docs/AUDIT-2026-09-14.md`).

```sh
# once: the candidate's spoken answers (Kokoro, voice am_adam, 48 kHz WAVs)
node scripts/browser-harness/make-answer-bank.mjs scripts/browser-harness/bank
npm i --no-save playwright-core        # not a project dependency

# a dev server of the app (NOT the one you develop in — two `next dev` in one
# checkout share .next/; use a git worktree for the harness server)
node scripts/browser-harness/harness.mjs stt   http://127.0.0.1:3100 ./harness-out
node scripts/browser-harness/harness.mjs probe http://127.0.0.1:3100 ./harness-out
node scripts/browser-harness/harness.mjs hr    http://127.0.0.1:3100 ./harness-out
node scripts/browser-harness/harness.mjs tech  http://127.0.0.1:3100 ./harness-out
```

- `stt` runs the recogniser-failure scenarios (`SCENARIOS=pass,fail-once,empty,partial,timeout-once,rate-limited`)
  by intercepting `/api/stt` after Start and records, per `/api/interview` POST, exactly what the
  server was asked to read.
- `probe` runs the mic check, starts, lets two turns play and reports which engine spoke.
- `hr` / `tech` run a whole round (HR reloads the page at turn 4 to exercise resume) and transcribe the
  interviewer's first lines from the captured audio graph.
- `VERCEL_BYPASS=<automation bypass secret>` lets it drive a protected Preview.
- Groq Whisper allows 20 requests/minute per org: run one session at a time.
