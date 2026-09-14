# End-to-end verification — v1.2.1 (2026-08-25)

Everything in this document was **measured**, not estimated, by driving the
production build (`next build` + `next start`) of this exact source with scripts
that speak to the API the way the browser does. Where a number changed between
the first run and the fixed build, both are given.

Environment: Windows 11, Node 24.19, Next.js 15.5.20, local `next start` on
`127.0.0.1:3000`. Configured keys: `GROQ_API_KEY`, `SUPERMEMORY_API_KEY`,
plus a throwaway `AUTH_JWT_SECRET` (mandatory in production). The local
Chatterbox TTS server was **not** running, so `engine:"cloud"` resolved to Groq
Orpheus and the on-device Kokoro path was exercised only by unit tests.

## 1. What was driven

| Harness | What it does |
|---|---|
| `e2e.mjs` | Capability probes → speculative opening → 4 streamed HR turns (SSE parsed like the client, TTFB / first token / first closed sentence / total) → the two TTS draws a turn costs → cached ack twice → TTS→STT round trip → score / GD / guidance → malformed inputs → secret-leak sweep |
| `crash-repro.mjs` | Four ways a browser disconnects: abort mid-SSE; drop a JSON upload mid-body; drop a multipart upload mid-body; headers only then drop. Checks `/api/health` after each |
| `ort-stage.mjs` | Boots the server and checks, after each staged request, whether the native onnxruntime binding has been loaded into the server process |
| `e2e-rounds.mjs` (review agent) | Full HR round to `done`, full technical round incl. the coding slot, a second session on the same guest cookie 35 s later, a stranger session, odd inputs ("yes", a question back, "I am 900 years old", `(no answer)`); run once unpaced and once with 8 s between turns |
| `e2e-concurrency.mjs` (review agent) | 8 simultaneous candidates; 12 concurrent cached TTS + 3 distinct; a streamed-turn abort; 35-request burst against the per-client limiter; malformed bodies |

TTS discipline: Groq Orpheus is metered at **100 requests/day**, so every run
was capped at ≤4 uncached synthesis requests and reused the cached line
`"Mm, okay."` for everything else.

## 2. Latency — single client, warm server

| Step | Run 1 (1.2.0) | Run 2 (1.2.1) |
|---|---|---|
| `GET /api/health` | 84 ms | 65 ms |
| `GET /api/tts` / `GET /api/stt` capability | 59 / 25 ms | 24 / 33 ms |
| Opening turn (speculative, JSON) | 789 ms | 706 ms |
| Streamed turn — TTFB | 303–640 ms | 591–857 ms |
| Streamed turn — first token | 303–642 ms | 592–857 ms |
| Streamed turn — first **closed sentence** (voice can start) | 384–669 ms | 672–943 ms |
| Streamed turn — complete | 422–728 ms | 737–1028 ms |
| TTS draw 1, streamed (opening sentence) — first audio byte | 816 ms (4.6 s audio) | 911 ms (5.0 s audio) |
| TTS draw 2, buffered (remainder) | 1482 ms (8.7 s audio) | 1474 ms (8.6 s audio) |
| Cached ack — miss / **hit** | 524 / **14 ms** | 536 / **16 ms** |
| TTS → Groq Whisper round trip | 265 ms, 100 % words | 304 ms, 100 % words |
| Rate-limit / traversal / over-long → 400 | 13–15 ms | 10–13 ms |

Run-to-run variance in the LLM numbers is Groq's, not ours: both runs fired
four turns back-to-back with no answering time, which is exactly the load a
free-tier bucket dislikes (see §5).

**What the candidate experiences per turn** (cascaded pipeline, no
speculation): end of speech → VAD cut (~600 ms) → Whisper (~300 ms) → first
closed sentence (~700 ms) → first audio (~900 ms on Groq; ~100–300 ms on
Kokoro once warm) ≈ **2.5 s** from the last word to the interviewer speaking.
That is the structural floor of an HTTP-cascaded design with a free-tier cloud
voice; it is not a bug to be found in the code.

## 3. Load — eight candidates at once

| Metric | 1.2.0 | 1.2.1 |
|---|---|---|
| 8 simultaneous streamed turns, all 200 | ✔ | ✔ |
| TTFB p50 / p95 | 858 / 1440 ms | 427 / 862 ms |
| First closed sentence p50 / p95 | 942 / 1524 ms | 588 / 953 ms |
| Whole turn p50 / p95 | 1042 / 1576 ms | 428 / 956 ms |
| 12 concurrent cached TTS | 12 × hit, p95 90 ms | 12 × hit, p95 90 ms |
| 3 distinct synths through the 2-in-flight gate | 614 / 660 / 912 ms, no 429 | 436 / 668 / 894 ms, no 429 |
| Per-client limiter: 35-request burst | not run (server dead) | 30 × 200 then 5 × 429 JSON (`"You're going a little fast…"`), other candidate unaffected (200) |

## 4. Robustness — the finding that mattered most

**1.2.0: one client disconnecting killed the whole server.**

```
[Error: aborted] { code: 'ECONNRESET' }
 ⨯ uncaughtException:  [Error: aborted] { code: 'ECONNRESET' }
…/node_modules/phonemizer/dist/phonemizer.js:1   ← 1.3 MB source line dumped as "context"
Error: aborted  at abortIncoming (node:_http_server:911:17)
[exited with code 7]
```

Reproduced deterministically (`crash-repro.mjs`): `before: UP 200` → `after A
(abort mid-SSE): DOWN`. Mechanism, established by reading the modules
involved: Next.js's own `process.on('uncaughtException')` merely logs the
aborted request — but `kokoro-js` was reaching the server bundle through
`serverExternalPackages`, Next preloads page bundles at start, and its
dependency `phonemizer` (Emscripten glue) installs
`process.on("uncaughtException", e => { throw e })` when evaluated in Node.
That handler rethrew inside the handler chain; exit code 7 is Node's "the
exception handler itself failed". The same leak put **210 MB of
onnxruntime-node binaries** into the `/interview` and `/gd` serverless
functions (220 MB each; Vercel's limit is 250 MB).

**1.2.1:** the browser-only ML stack is stubbed out of the server build by an
externals handler in `next.config.ts` (a resolve alias was not enough — Next's
built-in external list already names `@huggingface/transformers` and
`onnxruntime-node`, and externals are decided before aliases).

| Check | 1.2.0 | 1.2.1 |
|---|---|---|
| onnxruntime loaded in the server process at boot | **yes** (`"requested API version [24]…"` on every start) | no |
| abort mid-SSE | server **DOWN** | `UP 200`, next turn from the same client 200, `unhandled:false` |
| JSON upload dropped mid-body | (server already dead) | `UP 200` |
| multipart upload dropped mid-body | — | `UP 200` |
| headers only, then drop | — | `UP 200` |
| `/interview` function trace | 220.6 MB (198.8 MB ML) | **1.3 MB** (0 ML) |
| `/gd` function trace | 220.5 MB | **1.2 MB** |
| `test/server-bundle-hygiene.test.ts` | — | reads the build output; fails if any of it comes back |

Malformed input (all 1.2.1): multipart to a JSON route → 400; 121-entry
history → 400 with the zod message; unknown speaker → 400; 61-char name → 400;
whitespace name → 400; emoji-only name → 200 (schema-valid). A 6 MB JSON body
was **accepted and fully buffered** (523 ms) before validation in 1.2.1's first
build; the middleware now refuses oversized bodies on `Content-Length` with a
413 before any route reads them.

## 5. The token budget — why the interviewer "felt scripted"

Measured against Groq's free tier: **every model has its own 8,000
tokens-per-minute bucket** (spending 2,673 tokens on `gpt-oss-20b` left
`gpt-oss-120b`'s remaining count untouched), refilling continuously.
Measured prompt cost of one interviewer call, via `buildPrompt()`:

| History | Tokens (chars ÷ 4) |
|---|---|
| 0 turns | ~1,694 (the fixed instructions) |
| 4 turns | ~1,937 |
| 8 turns | ~2,139 |
| 16 turns | ~2,514 |
| 24 turns | ~2,736 |
| technical + résumé profile, 8 turns | ~2,299 |

In 1.2.0 each candidate answer could cost **three** of those on one model — a
speculative guess while they were still talking, the real turn, and the
scorer — i.e. ~6,000+ of an 8,000/min bucket. The server log confirmed it:
`groq main model rate-limited, retrying on openai/gpt-oss-20b` on 3 of 5 calls
in a 4-turn session; in the review agent's unpaced full round **HR turns 5–12
of 12 were scripted** (the fallback model 429'd too). With 8 s between turns:
1 of 45.

1.2.1 changes, each pinned by unit tests:

| Change | Effect on the interviewer's bucket |
|---|---|
| Background brains (score, guidance, résumé, GD) on `qwen/qwen3.6-27b` with `reasoning_effort:"none"` — its own bucket; 129 ms for a rubric in the probe | scoring no longer competes |
| Mid-answer speculation refused on metered brains (`{turn:null}`, client already handles it); the opening pre-fetch still runs | spend per answer halves |
| A 429 whose `try again in` ≤ 2 s is waited out on the **same** model before falling back | the candidate keeps the bigger model across a brief limit |

Measured effect on the background brains, same harness, same unpaced four
turns immediately before them:

| Route | 1.2.0 (shared bucket) | 1.2.1 first build (qwen thinking on) | 1.2.1 final (`reasoning_effort:"none"`) |
|---|---|---|---|
| `POST /api/score` | 971 ms, `scorer: groq` | 3789 ms, **heuristic** (JSON never parsed) | 1134 ms, `groq` |
| `POST /api/gd` model batch | 895 ms, `groq` | 1297 ms, **scripted** | 406 ms, `groq` |
| `POST /api/guidance` | 888 ms, `groq` | 4990 ms, **heuristic** | 926 ms, `groq` |

The middle column is the honest record of a regression I introduced and the
harness caught: qwen3.6-27b is a thinking model and spent the whole 900-token
budget inside `<think>`. The probe that settled it: no switch → 1961 ms,
`finish_reason: length`, empty content; `reasoning_effort: "none"` → 129 ms,
21 completion tokens, valid JSON; `"low"` → 400 (`must be one of none or default`).

A real candidate answering every 20–40 s now uses ~2,300 tokens/answer against
8,000/min. Eight candidates at once (§3) will still exhaust the bucket — that
is the tier, not the code; the fallback chain (120b → 20b → scripted) is what
keeps the room alive, and `turn.scripted:true` tells the client when it fired.

## 6. Type of responses — what the interviewer actually does

From the review agent's full HR and technical rounds (45 paced turns) and the
odd-input scenario, judged as a placement coach would:

- Reacts before asking on every turn ("That redesign sounds like a clever
  optimization. Can you explain how you decided on the two-chunk limit…").
- One question per turn on 41 of 45; 4 were double-barrelled. The prompt now
  names that form explicitly.
- Persona: introduces itself as "Haris, the AI interviewer" and stays honest
  about being an AI when asked; one greeting mis-spelled it "Haras".
- Rounds end with `done:true` within 18 turns (HR) and the technical round
  presents the coding exercise at its slot and accepts a fenced submission.
- Odd inputs: "yes" → asks for a specific problem; a question back ("what
  does this role involve day to day?") → answered concretely (six-week
  training, PR reviews, a buddy) then a next question; "I am 900 years old" →
  "Sounds like you're feeling confident! But let's get back to the real
  interview." then a real question; `(no answer)` → re-asks the same question in
  simpler words without advancing.
- Defects found and fixed: a thin answer was re-asked in new words up to three
  times and salary was asked twice (prompt tightened); a code review praised a
  correct two-sum submission for a first-non-repeating-character problem
  (review now checks the exercise set first); the model's `questionIndex` label
  is noisy (5 → 4 → 5 → 3) and the scripted rescue restarts its count, so the
  client's progress and scoring ids are now monotonic.
- Cross-session memory: guests now carry a durable id and asked questions are
  stored; under eight-way load Supermemory recall timed out on 6 of 8 turns
  (timeouts raised, misses no longer cached for ten minutes). A two-session
  no-repeat run is still the acceptance test to do by hand.

## 7. In a real browser — a whole interview with a fake microphone

The API harness cannot see the browser half of the pipeline, so a real Chrome
(Playwright `playwright-core`, `channel: "chrome"`, headless) was driven
through an HR round with Chromium's fake-microphone flags fed from a WAV: a
20-second candidate answer synthesised by Windows SAPI, padded with 30 s of
silence, looped. Instrumentation injected before any page script:
`AudioBufferSourceNode.start` (every Kokoro/cloud audio start),
`speechSynthesis.speak` (the robotic system voice), a `MutationObserver` on the
caption, and the screen-reader phase region. Three runs, fresh profile each:

| | Run 1 (as shipped) | Run 2 (gate, first attempt) | Run 3 (gate fixed) |
|---|---|---|---|
| Voice engine chosen | kokoro | kokoro | kokoro |
| Model download (12 files, fp32 WebGPU 325 MB) | started on Start click | started on Start click | started at mic-check, **preroll held Start until 100 %** |
| `speechSynthesis` utterances (robotic voice) | **2** — greeting + whole 2nd turn | **3** — the greeting, all three sentences | **0** |
| Candidate turns completed in the window | 8 | 6 | 6 |
| Caption change → nearest audio start | −2…−4 ms on interviewer lines; nudges +1.4 s ahead | — | **−1…−106 ms on every line, nudges +3 ms** |
| "Answer recorded" → first syllable | 5.6–7.2 s | — | **2.3–3.7 s** (5.4 s for the very first line: one-time graph warm-up; a run 4 with a discarded warm-up generation in the preroll brought the first line to 3.8 s, later turns 3.4–4.7 s) |
| `/api/stt` (Groq Whisper, VAD-segmented) | 30 calls, mic-check heard "Hi, I am Koseek." | 24 | 22 |
| Page errors | favicon 404 ×2 | favicon 404 ×2 | none (an `app/icon.svg` now exists) |

What the runs established:
- **A first-time visitor heard two voices.** Kokoro is a one-time download;
  in a fresh profile it took ~50 s, the 8 s hold in `floorSpeak` expired, and
  the greeting (run 1: and the whole second turn) came out of the system voice
  before Kokoro took over. The preroll now holds "Start the interview" until
  the voice is ready and shows the progress; a first attempt at that gate had
  a race (the preroll rendered before the engine probe answered, so a Start
  clicked within ~300 ms went through — run 2), fixed by treating "engine not
  yet resolved" as not ready.
- **Captions follow the voice.** On every interviewer line the caption changed
  within ~100 ms of the audio actually starting; the nudge caption used to
  appear 1.4 s before its audio and now lands with it.
- **First audio is ~2× sooner.** Kokoro renders a whole chunk before playing,
  so the first chunk's length is the latency; opening with the first clause
  past a 28-character floor cut "answer recorded → first syllable" from
  5–7 s to 2.3–3.7 s.
- The VAD-segmented Groq Whisper path is what a Chrome user actually gets
  (`caps.cloud = "groq"` outranks the browser recogniser), and it heard the
  synthetic candidate correctly on every turn.
- Two `[W:onnxruntime]` console lines per session are ORT's own execution-
  provider notice, not errors.

Still not verified by a machine: barge-in on speakers (the fake mic cannot
hear the page's own output, so echo behaviour needs a real room), the GD room's
live mic, and Chatterbox (the user's preferred voice; every Chatterbox path is
unit-tested, but the server was down for both sessions). Per-IP limits are
inert without a reverse proxy and the limiter is per-instance without Upstash
— both documented, both fine behind Vercel.

## 8. Reproducing

```powershell
npm run check                                  # typecheck + 2,149 tests + build
$env:AUTH_JWT_SECRET = "<64 hex chars>"; npx next start -p 3000
node e2e.mjs http://127.0.0.1:3000 out.json     # the harnesses live outside the repo;
node crash-repro.mjs 3000                       # recreate from §1 if needed
```
