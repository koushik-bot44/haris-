# Changelog

All notable changes to the Placement Day Simulator.

## [1.2.1] - 2026-08-25

**Survives real traffic.** 1.2.0 was verified by type-checks, unit tests and a
build. This release is what changed once the production build was actually run
and driven end to end — single client, eight concurrent candidates, full HR and
technical rounds, client disconnects — with every number below measured against
`next start` on this source. Full report: `docs/E2E_VERIFICATION.md`.

### Fixed — production stability
- **One client closing a tab killed the whole server.** A candidate aborting a
  streamed turn raised `'aborted'`/`ECONNRESET` on the Node request. Next.js
  logs that and carries on — but `kokoro-js` was reaching the *server* bundle
  through `serverExternalPackages`, Next preloads page bundles at start, and
  its dependency `phonemizer` (Emscripten glue) installs
  `process.on("uncaughtException", e => { throw e })` when evaluated in Node.
  That handler rethrew inside the handler chain and the process exited (code 7).
  Reproduced deterministically; every concurrent interview died with it. The
  browser-only ML stack is now stubbed out of the server build with empty
  modules (`next.config.ts`), and `test/server-bundle-hygiene.test.ts` reads
  the build output so it cannot come back.
- The same leak put **210 MB of onnxruntime-node binaries into the `/interview`
  and `/gd` Vercel functions** (220 MB each against a 250 MB limit). Gone with
  the stub.

### Fixed — the interviewer's token budget (why it "felt scripted")
Measured: Groq's free tier gives **every model its own 8,000 tokens/minute**,
and one interviewer turn costs **~2,000–2,700 tokens** (1,700 of fixed
instructions + ~50 per turn of history). The app was spending up to three of
those per candidate answer on ONE model — a speculative guess, the real turn
and the scorer — so a candidate answering every 30 s drained the bucket, the
main model returned 429, the fallback model 429'd too, and the round silently
became the fixture bank: in an unpaced run **HR turns 5–12 of 12 were
scripted**. Three changes, each pinned by tests:
- **Background brains run on their own bucket** (`lib/llm/complete.ts`):
  scoring, guidance, résumé analysis and the GD debate now use
  `qwen/qwen3.6-27b` (~110 ms, separate 8k/min), falling back to the
  interviewer's model only when that fails. `LLM_BACKGROUND_MODEL` overrides.
- **Mid-answer speculation is off on metered brains** (`app/api/interview/route.ts`).
  The guess doubled spend per turn and most guesses are discarded. The opening
  pre-fetch (empty history, hidden behind the mic check) still runs.
  `LLM_SPECULATE=1` forces it on.
- **A short rate-limit wait keeps the main model** (`lib/llm/chat.ts`). Groq's
  429 says "try again in 600ms"; the app now waits up to 2 s and retries the
  same model before switching to the smaller one, so the interviewer's
  judgement no longer changes character between turns for want of half a second.
- **Qwen gets `reasoning_effort: "none"`** (`lib/llm/chat.ts`). The first
  build of this release moved the background brains to qwen3.6-27b with its
  thinking left on: it spent the whole 900-token budget inside `<think>`,
  returned empty content, and every score, guidance and GD batch silently fell
  to the heuristics (3.8 s / 5.0 s / scripted). The harness caught it; with the
  switch the same rubric prompt answers in 129 ms. Groq accepts only
  `none`/`default` for Qwen — `"low"` is a 400.
- **Oversized bodies are refused before they are read** (`middleware.ts`).
  A 6 MB JSON body to `/api/interview` was buffered in full (523 ms) before the
  schema rejected it. Each costed route now has a `Content-Length` cap above its
  own schema ceiling and answers `413 payload_too_large` without spending a
  rate-limit token.

### Fixed — conversation and hearing (independent review of the turn-taking rewrite)
- A one-word answer ("Yes.", "No.") never reached the transcriber: the VAD's
  300 ms floor was measured between block timestamps, so ~300 ms of speech
  measured 170–255 ms and was dropped as a noise blip. Floor lowered to 150 ms
  with a real-block-timing regression test (`lib/vad.ts`).
- "Try voice again" mid-answer threw away the rescued partial answer.
- The barge-in warm-up was anchored on the first syllable only; on a streamed
  turn the window could already be spent when the mic opened.
- A late `onDegrade` from a superseded live-mic session could capture a newer
  session's transcript and open a second mic.
- After a barge-in, a nudge put the full never-spoken question back on screen.
- The progress index is now monotonic on the client: the model's own
  `questionIndex` label is noisy (5 → 4 → 5 → 3 in a live round) and the
  scripted rescue restarts its count, so progress visibly rewound and a new
  question's answer could be filed under an old id (`hooks/useInterviewMachine.ts`).

### Fixed — the first visit (found by driving a real Chrome with a fake microphone)
- **The greeting came out of the robotic system voice on a first visit.** The
  on-device model is a one-time download (~90 MB on WASM, ~330 MB fp32 on
  WebGPU, measured); it took ~50 s in a fresh browser profile, the 8 s hold in
  `floorSpeak` expired, and the greeting plus the whole second turn were spoken
  by `speechSynthesis` before Kokoro took over at 55 s — a different voice a
  minute in, on every first visit. The preroll now holds "Start the interview"
  until the voice is ready and shows the download progress
  (`voiceWarmup` in `hooks/useInterviewMachine.ts`, `kokoroProgress()` in
  `lib/tts-kokoro.ts`); the backstop hold for a mid-round reload is 20 s.
- **5–7 s from "answer recorded" to the first Kokoro syllable.** Kokoro renders
  a whole chunk before any of it plays, and draw 1 was a full ~8 s sentence.
  `kokoroChunks()` now opens with the first clause past a 28-char floor, so the
  first render is short and the pipelined generate-next-while-playing hides the
  rest (`lib/tts.ts`, `test/kokoro-chunks.test.ts`).
- Nudge captions ("Mm-hm — go on?") appeared ~1.4 s before their audio; they
  now land with the first syllable like every other line.
- Kokoro's first generation paid a one-time graph/shader warm-up (5.4 s to the
  greeting's first syllable vs 2.3–3.7 s afterwards); a discarded "Hello." is
  now generated right after the model loads, during the preroll.
- Every page load asked for `/favicon.ico` and got a 404; `app/icon.svg` now
  exists and Next links it.
- Verified in the same run: captions change within **2–4 ms** of the audio
  start on every interviewer line (the caption-follows-voice change), the
  VAD-segmented Groq Whisper path transcribes the fake mic correctly, and
  eight candidate turns complete with zero page errors.

### Fixed — voice core (independent review)
- A draw-2 buffer prepared *before* the session latched to the on-device voice
  was still played in the server voice right after draw 1 fell back — one turn,
  two voices, the exact split the latch exists to prevent.
- Chatterbox draw 2 went through `/v1/audio/speech`, which ignores
  `temperature`/`exaggeration`/`cfg_weight`, so the two halves of a turn were
  sampled at different temperatures. Both draws now use the native `/tts`.
- `deferredSpeak` did not release `done` on cancel while Kokoro was still
  downloading: a barge-in in a degraded session froze the turn for up to 8 s.
- `playBuffered` could start a source after `cancel()` during its
  `ensureRunning()` wait; `engineUsed` reported the server engine while Kokoro
  actually spoke; a bad first Orpheus clip surfaced after `200 audio/wav` had
  been sent and cost a second synthesis request.

### Fixed — brain and memory (independent review)
- `parseStreamedTurn`: a quoted control-shaped object at the very end of a
  sentence was still adopted as control; control JSON was sliced from the first
  `{` to the *last* `}` (two control lines → every field defaulted); the caption
  and the parser cut at different places; `scrubSpoken` dropped a whole line
  when the model put control before speech. Replaced with a string-aware
  balanced-object scan (`objectEnd`) used consistently by both paths.
- `extractQuestion` split on any `.` — including inside `Next.js` — so stored
  asked-questions were fragments.
- Supermemory writes timed out under load (4 s → 10 s; they are fire-and-forget)
  and a single failed recall was cached for the full 10 minutes (now 30 s).
- Prompt: a thin answer is no longer re-asked in other words; package/salary is
  asked exactly once; a code review first checks the submission solves the
  exercise that was actually set (a live run praised a correct two-sum for a
  first-non-repeating-character problem); double-barrelled questions are named
  as stacked.

### Fixed — GD room
- `candidateFinals()` is now a wrapper over `dropSelfEcho()` so the echo rule
  cannot drift between the two rooms; an ack assigned during an await is no
  longer orphaned; a fully spoken line is no longer recorded with a spurious
  em dash when SPACE lands after the audio ends.

### Added
- `docs/E2E_VERIFICATION.md` — every measured latency and behaviour, for the
  thesis and for the next person who has to trust this deploy.
- `test/server-bundle-hygiene.test.ts`, `test/chat-rate-limit.test.ts`,
  `test/interview-speculation-gate.test.ts`, `test/llm-complete.test.ts`.

## [1.2.0] - 2026-08-25

**One interviewer, one voice — and captions that follow it.**

The reported symptom was "the interviewer has multiple voices". It had three
separate causes in two different environments, and finding them needed a live
audit of the deployed site and of the provider quotas, not just a code read.

### The multiple-voices bug, in full

**Cause 0 — the deployed site was a stale build.** `placement-day-simulator.vercel.app`
was serving a build from before the entire v1.1.0 voice layer: `/api/health` and
`/api/stt` answered **404**, `GET /api/tts` returned the pre-v1.1.0 shape with no
`cloud`/`engines` keys, and `POST /api/tts` rejected the current request body with
`400 invalid shape`. With no server voice reachable, every line was spoken by the
browser's `speechSynthesis`, whose voice is chosen by regex-matching whatever the
OS has installed — and `loadVoices()` can resolve with an **empty** list, so early
lines got the default voice and later ones got the matched one. That is the voice
change users actually heard in production. See `docs/DEPLOYMENT.md`.

**Cause 1 — one synthesis request per sentence, each able to fail alone.**
`lib/speech-queue.ts` sent one `POST /api/tts` per closed sentence, and
`serverSpeak`'s catch in `lib/tts.ts` called `floorSpeak()` **per sentence**. A
single failed request re-voiced exactly that sentence through a different engine
while its neighbours kept the real one.

**Cause 2 — the quota made that failure routine.** Measured against the live Groq
API: `x-ratelimit-limit-requests: 100` for Orpheus TTS with a ~24h refill, i.e.
**100 requests per day**. The app spent 5 on pre-generated acks before a word was
spoken and ~1 per sentence after that, so a single interview cost ~50. Two
interviews exhausted the day's voice budget, after which every sentence was a
coin flip between Orpheus and the robotic fallback.

### Changed
- **The two-draw rule** (`lib/speech-queue.ts`, rewritten). A turn is now at most
  **two** synthesis requests: the opening sentence live for a fast start, then the
  entire remainder as ONE utterance, prepared while the opening plays so the
  hand-off stays gapless. Independent draws of a neural TTS differ in pace and
  energy even when they all succeed, so fewer draws is a voice-consistency fix as
  much as a quota one.
- **A session-wide degrade latch** (`lib/tts.ts`). Once a server engine fails, the
  whole session moves to the on-device voice and stays there. Degrading is fine;
  degrading repeatedly, per sentence, is the bug.
- **Engine order is now chatterbox → on-device → cloud** (`lib/tts.ts`). The local
  [Chatterbox](https://github.com/devnen/Chatterbox-TTS-Server) server wins when
  it is running: unmetered, studio voices, and the only engine that performs
  paralinguistic tags. Cloud engines are last, and a metered one (Groq at 100/day)
  is **never** chosen automatically. Production therefore speaks with Kokoro-82M
  on-device and needs no API key at all.
- **Captions follow the voice, not the token stream** (`hooks/useInterviewMachine.ts`,
  `lib/speech-queue.ts`). The model finishes writing a turn seconds before the
  voice finishes saying it, so captioning generation put the whole question on
  screen before the interviewer had spoken a word — which reads as lag even when
  the audio is on time. Each draw is now captioned when its audio starts.
- **Chatterbox is driven deterministically** (`app/api/tts/route.ts`). A fixed,
  non-zero `seed` derived from the persona (seed 0 means "re-roll" to that server),
  plus a lower `temperature`, so successive utterances of one voice keep the same
  character. `chunk_size` is pinned to the documented minimum of 50 because
  Chatterbox renders a whole chunk in one forward pass — that value *is* the
  time-to-first-audio. All knobs are env-overridable; see `.env.example`.
- **An explicit voice pick is stored separately from the auto-resolved one**
  (`lib/tts.ts`). They previously shared a key, so the first automatic answer
  became permanent: one session with Chatterbox down would pin the app to the
  on-device voice forever.

### Fixed
- Groq Orpheus serves exactly six voices (`autumn diana hannah austin daniel
  troy`, verified against the API). The cast used only three, so the GD moderator
  and the data debater were **literally the same speaker**. Six personas now map
  to six voices (`lib/voice-cast.ts`).
- `TURBO_TAGS` listed 4 of Chatterbox-Turbo's 9 tags. Unknown bracketed text is
  deliberately preserved, so a missing tag survived stripping and a cloud engine
  read it aloud — `[laugh]` spoken as the word "laugh" (`lib/speakable.ts`).
- `concatClipsStream` silently **skipped** a clip whose format or sample rate did
  not match, deleting words from the middle of a sentence with nothing logged. It
  now fails, so the fallback speaks the complete text (`lib/tts-engines.ts`).
- `/api/tts` buffered every line under 160 characters even when the client asked
  to stream — i.e. every turn's opening sentence, the one streaming exists to make
  fast. It now streams and fills the cache from the same bytes via `tee()`.
- `prepareSpeak().play()`'s `cancel()` was a no-op during its `ensureRunning()`
  await, so a barge-in in that window let the line play on. GD persona turns now
  route through prepared buffers, so this was on the interruption path.
- **Question repetition, the feature Supermemory was added for, did not work.**
  Only candidate *answers* were ever stored, never the questions asked, so there
  was no data to avoid a repeat with; and it never ran at all in production
  because it was gated on a signed-in user id while the deployment has no
  accounts. Questions are now recorded per candidate per round, guests get a
  durable identity, and the legacy `pds_candidate_*` container tag is still read
  so existing data is not orphaned.
- The fix above initially made things **worse**: the "already asked" list included
  the current session, and since the bank is filtered by that list *before*
  drawing, it re-ordered mid-round and broke position tracking — the scripted HR
  round asked 3 of 5 questions with indices skipping 1→3→5 and spoke one follow-up
  three times, twice consecutively. `avoid` now carries cross-session memory only.
- Deep probes were drawn independently per question from a **4-item pool across 5
  questions**, so a verbatim repeat inside one round was guaranteed by the
  pigeonhole principle. Now a seeded permutation over a 6-item pool
  (`lib/llm/interview-flow.ts`).

- The speech queue resolved `done` as soon as it had spoken what it currently
  held, **without waiting for `end()`**. Sentences pushed after that were
  accepted by `push()` — `size` grew, so the caller was told they were queued —
  and never spoken. Any model stall longer than 1.5s behind a short opening
  sentence therefore truncated the reply to that one sentence while the caption
  and the stored transcript showed the whole paragraph. The queue now stays open
  until the caller closes it (`lib/speech-queue.ts`).
- `visibleStreamText` withheld only the `@`-prefixed partial control marker, so
  the fragments `{`, `{"`, `{"t`, `{"ty` … of an improvised bare-brace marker
  each reached the voice and the caption on successive stream ticks — the
  interviewer literally speaking punctuation — and the caption then shrank back,
  which cannot un-speak it (`lib/llm/parse.ts`).
- `parseStreamedTurn` treated a control-shaped object **anywhere** in the reply
  as control, including one the interviewer was quoting at the candidate. A
  technical round discussing a JSON response body had its question truncated at
  the brace *and* adopted the quoted `done: true`, ending the interview. The
  bare-brace form now only counts as control when nothing follows its closing
  brace; an explicit `@@CTRL` marker still wins anywhere (`lib/llm/parse.ts`).
- `envNum()` read a blank env var as the number 0, because `Number("")` is 0 and
  `Number.isFinite(0)` is true. Uncommenting `CHATTERBOX_SEED=` in `.env.example`
  without typing a value therefore selected seed 0 — "re-roll the voice every
  request", the exact drift the seed exists to prevent (`app/api/tts/route.ts`).
- `CHATTERBOX_VOICE` was documented configuration that could never take effect:
  it sat behind `chatterboxVoiceFor(key) ||`, which always returns a filename.
  Pointing it at a cloned voice silently kept `Emily.wav`. It now overrides the
  two 1:1 interviewer personas, matching `castVoice()`'s rule, while leaving the
  four GD debaters distinct.
- The non-streaming Chatterbox path checked `!res.ok` but not `!res.body`, so an
  upstream 200 with an empty body was forwarded as a 0-byte `audio/wav` — which
  `decodeAudioData` throws on instead of taking the clean 502.
- The interviewer prompt offered the model 4 of Chatterbox-Turbo's 9
  paralinguistic tags. The list is now derived from `TURBO_TAGS` so the prompt
  and the stripper can never disagree (`lib/llm/claude-cli.ts`).

### Added
- `docs/DEPLOYMENT.md` — how to prove a deploy actually landed, which is what
  nobody could do while the live site silently served a months-old build.
- **1,451 new test cases** (463 → 2,083 across 53 files), covering the API
  contract of every route, the `@@CTRL` streaming protocol, sentence
  segmentation, WAV/PCM framing, the voice pipeline's single-voice invariants,
  and the STT reducer / VAD / barge-in state machines. Error and cancellation
  paths are covered at least as heavily as happy paths, since that is where this
  app's real defects live — six of the bugs listed above were found by these
  tests rather than by reading the code.
- Regression suites for the invariants above: `test/speech-queue.test.ts` (the
  two-draw rule), `test/voice-engine-resolution.test.ts` (engine order, including
  that the auto-resolved engine is not mistaken for a user choice), and
  `test/interview-scripted-repeat.test.ts` (a scripted round never repeats a line,
  never repeats one back-to-back, never skips a question index, and never speaks a
  follow-up before its question).

## [1.1.0] - 2026-08-24

**Real-time voice conversation on cloud APIs, and a production-hardened server.**

The fresh clone talked to a local voice server nobody had installed and went
silent when it failed; the brain was a scripted bank unless a key was hand-wired;
and the voice waited for the whole reply before speaking. This release makes the
conversation feel live — the first sentence is spoken while the model is still
writing the rest — on any of five cloud voices, with one key enough for brain,
voice and hearing.

### Added
- One OpenAI-compatible chat transport (`lib/llm/chat.ts`) for Groq, OpenAI,
  Gemini, OpenRouter and any self-hosted server; auto-selects by key, explicit
  `LLM_PROVIDER` override, rate-limit fallback model, clear failure kinds —
  and **model healing**: when the configured model is missing on the account
  (rosters rotate; a fresh Groq account has no llama-3.x at all) the server
  picks a usable one from `/models`, logs it, and carries on instead of
  silently dropping to the question bank. Reasoning-class models get a low
  effort setting and a larger completion budget.
- Cloud text-to-speech behind one streaming-WAV contract: ElevenLabs
  (`eleven_flash_v2_5`, PCM), OpenAI (`gpt-4o-mini-tts`), Deepgram Aura-2,
  Groq Orpheus (auto-chunked to its 200-char limit), Gemini TTS. `/api/tts`
  picks the best configured engine; `GET /api/tts` reports capabilities.
- A voice cast (`lib/voice-cast.ts`): every persona has a distinct voice on
  every engine; legacy wav names still resolve.
- Sentence pipelining: the SSE reply is split into closed sentences and fed to
  a speech queue that synthesizes sentence N+1 while N plays (`lib/speech-queue.ts`,
  `lib/sentence-split.ts`).
- Cloud transcription (`/api/stt`: Groq Whisper turbo / OpenAI / Deepgram) with
  an on-device VAD-segmented adapter that works in every browser, and Deepgram
  **live** streaming recognition via a server-minted 60-second token.
- `/api/health`, `app/error.tsx`, `app/not-found.tsx`, boot-time environment
  validation (`instrumentation.ts`) that refuses to start production without
  `AUTH_JWT_SECRET`.
- 60+ new unit tests (sentence splitting, WAV framing, voice cast, backend
  selection, env guard, Orpheus chunking, rate-limit isolation, scoring status,
  resume heuristics, no-answer re-ask, rescue continuity).

### Changed
- The interviewer is never silent: cloud/studio → on-device Kokoro → system
  voice, and the room shows which one actually spoke.
- Kokoro loads q8 on WASM when WebGPU has no usable adapter, and retries after
  a failure; prepared (speculative) audio is waited for instead of discarded.
- Middleware runs on the Node runtime; login/register are rate-limited per
  client AND per IP; the daily LLM budget is per client (+ per-IP ceiling)
  instead of one global kill-switch; `/api/sessions` requires sign-in and caps
  body size; `/api/stt` and `/api/stt/token` are limited.
- Long-term memory is keyed by the signed-in user id (never the typed name)
  and never written from speculative pre-fetches.
- Mock brain: chaos is opt-in (`LLM_MOCK_CHAOS=1`), latency 250–650 ms.
- Streaming TTS requests time out on connect only — a long turn is never cut
  off mid-sentence by a whole-request timer.
- Copy is truthful: barge-in hints only when it is on; privacy notes say what
  actually leaves the device; scripted/heuristic results are labelled by the
  real backend.

### Fixed (from an adversarially-verified 66-finding audit)
- GD room: re-grabbing the floor during the transcript settle reused a dying
  promise and froze the tab; adopted barge-in sessions carried the persona's
  echo into the candidate's turn; a stray syllable became an interjection;
  post-stop results could adopt a dead mic; rate-limit notices rendered as mic
  trouble.
- Interview room: a discarded barge-in listener could be promoted by a late
  final result and orphan the live one; early-start adoption re-ran barge-in
  logic; silent nudges replaced the caption with unspoken text; nudge echo
  ended answers; a "slow down" 429 was a dead end; speculation fired unbounded.
- Scripted flow spoke a different coding problem than the editor showed; the
  rescue restarted at question one; "(no answer)" advanced the interview;
  candidate questions without a "?" (speech never emits one) were not
  recognised; "the editor" in prose flipped the stage machine.
- Reports: WPM exploded on segment-based transcripts; ties named one criterion
  as both strength and weakness; scoring outages were blamed on the candidate;
  a malformed stored round crashed every reporting page; a full localStorage
  permanently degraded saves.
- Resume profile: "Engineering" flipped freshers to experienced; intern
  date-only lines counted as work; locations became employers; version numbers
  became "metrics"; month ranges were not counted; duplicate projects re-asked
  forever; headlines became names; "Spring 2024" became Spring Boot.
- Server: malformed `MONGODB_URI` crashed with a 500; a corrupted users file was
  overwritten as empty; the driver's default `test` database; Secure cookies on
  plain-HTTP production (`AUTH_COOKIE_SECURE=0`); shared "local" IP bucket with
  no proxy; ElevenLabs ignored the persona voice; Upstash outages were silent.

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
