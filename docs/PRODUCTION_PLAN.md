# Production Plan — Real-time Voice Interviewer

Date: 2026-08-24. Scope: take the freshly-cloned repo from "runs locally with a
scripted brain and a voice server nobody has installed" to a production-grade,
real-time voice conversation (Gemini Live / ChatGPT Voice class), deployable to
Vercel or any Node host with nothing but API keys.

## 1. Where the project actually stands (audit)

Verified on the clean clone: `tsc` passes, all 385 unit tests pass, `next build`
passes. So the "bugs" are **runtime and product-level**, not compile errors.
The four that explain almost every symptom the user reported:

| # | Symptom | Root cause | File |
|---|---------|-----------|------|
| 1 | **The AI never speaks** | Default voice engine is `chatterbox` — a *local* server at `127.0.0.1:8004` that is not installed. When it fails, `serverSpeak` deliberately stays **silent** ("never fall to the system voice"). Kokoro (on-device) is only warmed if the engine was already `kokoro`. Net: no key, no server ⇒ silence. | `lib/tts.ts` 22-32, 273-296 |
| 2 | **"AI not responding correctly" / feels scripted** | With no key `getProvider()` returns `mock` — a fixed question bank with simulated 0.8–1.8 s latency and a chaos mode that throws 1 in 17 calls. `.env.example` even sets `LLM_PROVIDER=mock` and documents a `gemini` provider that does not exist. | `lib/llm/index.ts`, `lib/llm/mock.ts`, `.env.example` |
| 3 | **Not real-time** | The LLM turn *is* streamed to the caption, but the voice deliberately waits for the whole turn before synthesizing (`streamTurn` returns `live: null`; the sentence-pipelining code is present but disabled). First audio = full LLM turn + full TTS. | `hooks/useInterviewMachine.ts` 814-837 |
| 4 | **Not production-safe** | Session JWTs fall back to a public dev secret; `/api/auth/*` is not rate-limited (brute-forceable); the user store writes `.data/users.json` (impossible on serverless); no security headers; middleware pulls the Node build of `@upstash/redis` into the Edge runtime. | `lib/session-jwt.ts`, `middleware.ts`, `lib/user-store.ts`, `next.config.ts` |

A parallel, adversarially-verified bug hunt across all eight subsystems runs
alongside this plan; its confirmed findings are folded into Phase 6.

## 2. Target architecture

```
 browser                                     server (Next.js route handlers)
 ───────                                     ─────────────────────────────
 mic ─► STT engine ──► transcript ──► POST /api/interview (SSE) ──► LLM backend
        chrome | deepgram-live | cloud-whisper | on-device whisper        groq | openai | gemini | openrouter | custom | mock
                                          │ text deltas
                                          ▼
                              sentence splitter ──► TTS queue ──► POST /api/tts (streamed WAV/PCM)
                                                     │                       elevenlabs | openai | deepgram | groq | gemini
                                                     │                       chatterbox (local) — on-device kokoro — system voice (floor)
                                                     ▼
                                          gapless Web Audio playback ◄── barge-in (mic stays live)
```

Principles:

1. **One key is enough.** A single `GROQ_API_KEY` gives an LLM (sub-second),
   Whisper STT, and Orpheus TTS. A single `OPENAI_API_KEY` or `GEMINI_API_KEY`
   likewise covers LLM + TTS (+ STT for OpenAI). Mix and match is allowed.
2. **Never silent, never dead.** Every stage has a floor: scripted questions
   for the LLM, on-device Kokoro then the system voice for TTS, on-device
   Whisper then text mode for STT. The floor is *reported* in the UI, never
   hidden.
3. **Speak the first sentence while the rest is still being written.** LLM
   stream → sentence boundary → TTS → play, with the next sentence synthesizing
   while the current one plays. This is the single biggest latency win and is
   how ChatGPT Voice / Gemini Live feel instant.
4. **Server holds every secret.** Browsers only ever talk to `/api/*`. The one
   exception is the Deepgram live socket, which uses a 30-second temporary
   token minted server-side.

## 3. Work breakdown

### Phase 1 — LLM provider layer (server)
- `lib/llm/chat.ts`: one OpenAI-compatible chat-completions transport (SSE
  streaming, timeouts, 429 → fallback model, clear error kinds). Backends:
  `groq`, `openai`, `gemini` (OpenAI-compat endpoint), `openrouter`, `custom`
  (`LLM_BASE_URL`). Selection: explicit `LLM_PROVIDER`, else auto by key
  (groq → openai → gemini → openrouter → custom → mock).
- `lib/llm/api-provider.ts` replaces `groq.ts` as the interviewer brain for
  every backend (same `@@CTRL` protocol, same rescue).
- `lib/llm/complete.ts`: `llmText()` / `llmAvailable()` used by scoring,
  resume analysis, guidance and the GD debate — no more `groqEnabled()`
  sprinkled through the codebase; labels report the real backend.
- Mock: chaos **off** unless `LLM_MOCK_CHAOS=1`; latency 300 ms.

### Phase 2 — TTS engines (server)
- `lib/pcm-wav.ts`: streaming WAV framing (0xFFFFFFFF sizes) so raw PCM from
  any cloud engine rides the client's existing gapless streaming player.
- `lib/tts-engines/`: `elevenlabs` (`/stream`, `pcm_24000`, `eleven_flash_v2_5`),
  `openai` (`gpt-4o-mini-tts`, `pcm`), `deepgram` (Aura-2, `linear16`),
  `groq` (Orpheus, wav), `gemini` (`gemini-2.5-flash-preview-tts`, PCM).
- `lib/voice-cast.ts`: persona keys (`hr`, `technical`, `moderator`,
  `dominator`, `data`, `fence`) → per-engine voice ids, so the GD room keeps
  four distinct voices on every engine.
- `/api/tts`: `engine: "cloud"` → server picks `TTS_PROVIDER` or the first
  configured engine; `GET` reports what is available (no secrets).

### Phase 3 — Client voice pipeline
- Engine auto-select on boot: cloud → chatterbox (if running) → kokoro
  (auto-warm) → system while it loads. A stored stale choice never wins over a
  newly configured cloud engine.
- `lib/tts.ts`: restore the system-voice floor; cloud engines stream; failures
  walk the chain and **report** which engine spoke.
- `lib/speech-queue.ts`: ordered sentence queue with 2-deep synthesis
  look-ahead and gapless hand-off; `cancel()` kills everything (barge-in).
- `useInterviewMachine.streamTurn`: feed completed sentences into the queue as
  the SSE text arrives; on the final turn, reconcile against `turn.text`
  (speak the remainder, or restart cleanly if the rescue swapped the text).
- UI truthfulness: preroll/live copy reflects whether barge-in is on; engine
  chip shows the engine that actually spoke; stale "streaming lands next" note
  removed.

### Phase 4 — STT engines
- `/api/stt`: multipart audio → text via Groq `whisper-large-v3-turbo` or
  OpenAI `gpt-4o-mini-transcribe`; VAD-segmented so it behaves near-live.
- `lib/stt-cloud.ts`: browser adapter (mic → VAD segments → `/api/stt`) —
  works in **any** browser, not just Chrome.
- `lib/stt-deepgram.ts` + `/api/stt/token`: optional true-streaming STT
  (interim results, `UtteranceEnd`) using a 30 s temporary token; the
  best-in-class path when `DEEPGRAM_API_KEY` is set.
- Selection: explicit choice → deepgram (if configured) → Chrome → cloud →
  on-device Whisper → text mode.

### Phase 5 — Production hardening
- `AUTH_JWT_SECRET` **required** when `NODE_ENV=production` (fail fast with a
  clear message); user file-store refuses to run in production without Mongo.
- Middleware: rate-limit `/api/auth/login|register` and `/api/stt`; run on the
  Node runtime (fixes the Upstash Edge warning); `maxDuration` on streaming
  routes.
- Security headers (HSTS, nosniff, frame-ancestors, referrer, permissions
  policy scoped to microphone).
- `/api/health`: which LLM / TTS / STT backends are configured, DB/redis
  status, version — no secrets.
- `app/error.tsx`, `app/not-found.tsx`.
- `.env.example` rewritten by tier; README "Production" section; `vercel.json`.

### Phase 6 — Bug fixes from the verified hunt + tests
- Every confirmed finding fixed with a regression test where a pure function
  is involved; UI-only findings fixed directly.
- New unit tests: chat transport (SSE parsing, fallback), WAV framing, speech
  queue ordering/cancel, sentence splitter, voice cast, health, stt route
  validation, env selection.

### Phase 7 — Verification
- `tsc`, `vitest`, `next build` clean; dev server smoke: every page renders,
  `/api/health` reports engines, `/api/tts` streams with a real key when one is
  present, `/api/interview` streams with the configured backend.

## 4. Environment matrix

| Tier | Variables | What you get |
|------|-----------|--------------|
| Zero config | — | Scripted interviewer, Chrome STT, Kokoro/system voice. Runs, but not "smart". |
| **Recommended (free)** | `GROQ_API_KEY` | Sub-second adaptive interviewer, cloud Whisper STT (any browser), Orpheus TTS. |
| Best voice | + `ELEVENLABS_API_KEY` or `OPENAI_API_KEY` or `DEEPGRAM_API_KEY` | Studio-grade streamed voice; `DEEPGRAM_API_KEY` also unlocks true live STT with interim results. |
| Google stack | `GEMINI_API_KEY` | Gemini LLM (OpenAI-compat) + Gemini TTS. |
| Production | `AUTH_JWT_SECRET`, `MONGODB_URI`, `UPSTASH_REDIS_REST_URL/TOKEN` | Accounts, persistence, cross-instance rate limits. |

## 5. Status (2026-08-24, end of day)

| Phase | Status | Evidence |
|-------|--------|----------|
| 1 LLM layer | done | `lib/llm/chat.ts` (+ runtime model healing from `/models`), `api-provider.ts`, `complete.ts`; `test/chat-config.test.ts` |
| 2 TTS engines | done | `lib/tts-engines.ts`, `lib/voice-cast.ts`, `lib/pcm-wav.ts`, `/api/tts`; `test/tts-engines.test.ts`, `test/pcm-wav.test.ts`, `test/voice-cast.test.ts` |
| 3 Client pipeline | done (code) | `lib/tts.ts`, `lib/speech-queue.ts`, `lib/sentence-split.ts`, `useInterviewMachine.streamTurn`; `test/sentence-split.test.ts`, `test/tts-prepare.test.ts` |
| 4 STT | done (code) | `/api/stt`, `/api/stt/token`, `lib/stt-cloud.ts`, `lib/stt-deepgram.ts`, `lib/stt-segmented.ts`, engine selection in `lib/stt.ts` |
| 5 Hardening | done | `instrumentation.ts` + `lib/env-check.ts`, `middleware.ts` (Node runtime, auth + stt limits), per-client daily budget, security headers, `/api/health`, error pages, `.env.example`, README |
| 6 Bug fixes | done | 66 confirmed findings → fixed (see CHANGELOG 1.1.0); 460 unit tests green |
| 7 Verification | partial | `tsc`, `vitest`, `next build` clean; production boot + API smoke against the real Groq key: health, SSE streaming turn, security headers, 404, all guards OK |

**Verified live against this Groq account:** the roster has NO llama-3.x
models (only `openai/gpt-oss-120b/20b`, `qwen/qwen3.6-27b`, compound). The
defaults were changed accordingly and the server now heals a missing model at
runtime from `/models` (logged, remembered for the process).

**Voice verified (after the Orpheus terms were accepted on the Groq
account):** `/api/tts` buffered → finite 24 kHz WAV in 820 ms; streamed
3-sentence turn (over Orpheus' 200-char cap) → one streaming WAV of 20 s
assembled from chunks; the spoken WAV fed back through `/api/stt` transcribed
verbatim in 276 ms. Before acceptance the same call returned
`400 model_terms_required` and the client fell to the on-device/system voice.

**Not verifiable from a terminal (do this first in a real Chrome session):**
audio playback (AudioContext autoplay unlock on the mic-check click), Chrome
`SpeechRecognition`, the Deepgram live socket (`access_token` query auth),
Kokoro's WebGPU→WASM fallback, barge-in feel with headphones.

## 6. Acceptance criteria

1. Fresh clone + `GROQ_API_KEY` only → start an HR round → the interviewer
   greets **audibly** within ~1 s of "Start", reacts to what was said, and the
   first syllable of each reply lands < 1.5 s after the candidate stops.
2. No keys at all → still audible (Kokoro or system voice), still an interview
   (scripted), the UI says so.
3. Interrupting mid-sentence (barge-in on) stops the voice within ~300 ms and
   the interruption becomes the answer.
4. Any single provider outage degrades one step, never to silence or a dead
   screen; `/api/health` shows the degraded component.
5. `npm run build` clean; `npm test` green; production boots refuse an
   insecure JWT secret.
