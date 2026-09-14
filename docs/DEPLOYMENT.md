# Deployment — and how to prove a deploy actually landed

## The problem this document exists to prevent

On 2026-08-25 the live site at `https://placement-day-simulator.vercel.app/` was running a build that
predated the entire v1.1.0 voice overhaul. Every fix in this repo was invisible in production, and the
interviewer was speaking through the browser's built-in `speechSynthesis` — which is what produced the
"the interviewer has several different voices" bug that was being investigated in the code.

The build was stale for weeks and nothing said so, because a stale Next.js deploy looks completely
healthy: the pages render, the buttons work, and only the *behaviour* is old.

**So: never trust that a deploy landed. Verify it.**

## Verifying a deployment in 30 seconds

Three probes. Run them against the deployed URL after every deploy.

```powershell
$app = "https://placement-day-simulator.vercel.app"

# 1. Does this build even have the current routes?
Invoke-WebRequest "$app/api/health" -UseBasicParsing | Select-Object -Expand Content

# 2. What voice engines does the server think it has?
Invoke-WebRequest "$app/api/tts" -UseBasicParsing | Select-Object -Expand Content

# 3. Does the TTS route accept the CURRENT request shape?
Invoke-WebRequest "$app/api/tts" -Method POST -UseBasicParsing `
  -ContentType "application/json" `
  -Body '{"text":"Tell me about yourself.","engine":"cloud","voice":"hr","stream":false}'
```

### Reading the results

| Probe | Healthy | Stale build |
|---|---|---|
| `GET /api/health` | `200` with `{"version":"1.2.0", ...}` | **`404`** — the route does not exist in that build |
| `GET /api/tts` | JSON containing `cloud` and `engines` keys (the legacy `enabled`/`elevenlabs` keys are *also* still present — their presence proves nothing, their *absence* of `cloud`/`engines` does) | only `{"enabled":…,"elevenlabs":…}` — the pre-v1.1.0 shape |
| `POST /api/tts` | `200` with `content-type: audio/wav` and an `x-tts-engine` header naming the engine | **`400 invalid shape`** — old zod schema, rejects `voice:"hr"` |

`GET /api/health` is the authoritative check: it reports `version` straight from `lib/version.ts`, so if
that number is not the one in this working copy, the deploy did not land.

Measured against a local `next start` of this exact source on 2026-08-25, the three probes answered:
`200 {"ok":true,"version":"1.2.0","env":"production","llm":{"backend":"groq","model":"openai/gpt-oss-120b",…},"tts":{"cloud":["groq"],"chatterbox":false},"stt":{"cloud":"groq",…},"rateLimit":"memory","auth":{"jwtSecret":true,…},"memory":true}`,
`200 {"cloud":"groq","engines":["groq"],"chatterbox":false,"voices":[],"enabled":false,"elevenlabs":false}`, and
`200 audio/wav` (115,236 bytes, `x-tts-engine: groq`). That is what a correct Vercel deploy must print too.

> **Probe 3 is not free.** With only `GROQ_API_KEY` set, `engine:"cloud"` resolves to Groq Orpheus, and Orpheus
> is metered at **100 requests per day**. Each run of probe 3 spends one of them (a repeat of the *same* text is
> served from the in-process cache only while that lambda instance is alive). Run it once per deploy, not in a loop.

## Why the live build was stale

This working copy has **no `.git` directory and no `.vercel` directory**. It is not linked to the
deployment. The Vercel project is presumably connected to a separate GitHub repository, and the code in
this folder was never pushed to it.

To fix it you need to get this code into whichever repo Vercel builds from. Vercel deploys on push to the
production branch; there is no way to deploy this folder without either that repo or the Vercel CLI:

```powershell
npm i -g vercel
vercel link      # attach this folder to the existing project
vercel --prod    # deploy this exact code
```

## Environment variables

`.gitignore` contains `.env*`, so **`.env.local` was never committed and never reached Vercel**. Anything
the server needs must be set in *Vercel → Project → Settings → Environment Variables*, then redeployed
(env changes do not apply to existing deployments).

| Variable | Needed for | If unset |
|---|---|---|
| `GROQ_API_KEY` | the interviewer's brain (`openai/gpt-oss-120b`) and Whisper STT | falls back to the scripted question bank — the interview still runs but is not adaptive |
| `AUTH_JWT_SECRET` | signing session tokens | **fatal in production** — `lib/env-check.ts:21-28` refuses to boot when it is missing **or shorter than 32 characters**; generate with `openssl rand -hex 32` (64 chars) |
| `SUPERMEMORY_API_KEY` | cross-session memory / question anti-repetition | memory is a no-op, questions can repeat |
| `MONGODB_URI` | accounts and server-side history | guest mode only; `/api/auth/register` answers `503 "Accounts aren't available on this deployment yet"` (`lib/user-store.ts:205` refuses the JSON-file store in production) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | rate limiting that survives across lambdas | per-instance limits only, which is weak on serverless — see *Rate limiting on Vercel* below |
| `GROQ_BACKGROUND_MODEL` (optional) | the model scoring / guidance / résumé / GD run on — **a different token bucket from the interviewer's** | defaults to `qwen/qwen3.6-27b`; set it to the interviewer's model to go back to one shared 8,000 tokens/min bucket (not recommended — see `docs/E2E_VERIFICATION.md` §5) |
| `LLM_SPECULATE` (optional) | mid-answer speculative pre-fetch of the next turn | off on Groq (it doubled token spend per turn), on for unmetered brains; `1` forces on, `0` forces off |

None of these are required for the **voice** to work in production — see below.

> **Groq's real ceiling is tokens per minute, not requests per day.** Every model gets its own
> 8,000 tokens/min; one interviewer turn costs ~2,000–2,700. A single candidate is fine. Eight at
> once will hit the main model's limit and ride the fallback chain (120b → 20b → scripted). If the
> demo is a lab full of people, that is the moment to consider a paid Groq tier, not a code change.

### What is fatal and what is only a warning (`lib/env-check.ts`)

The guard runs once per server start from `instrumentation.ts:5-9` (Node runtime only). With `NODE_ENV=production`,
which Vercel always sets for `next build`/`next start`:

- **FATAL** (the function throws at boot, every request 500s): `AUTH_JWT_SECRET` missing (`env-check.ts:21`) or
  shorter than 32 characters (`:26`). Nothing else is fatal.
- **WARNING** (logged, service degrades): no `MONGODB_URI` (`:29`), no Upstash pair (`:32`), no LLM key (`:38`),
  no voice key and no `CHATTERBOX_URL` (`:44`), an unknown `LLM_PROVIDER` (`:47`), `LLM_PROVIDER=claude-cli` (`:50`).

So the **minimum working set on Vercel is exactly** `AUTH_JWT_SECRET` + `GROQ_API_KEY`, with `SUPERMEMORY_API_KEY`
optional. `/api/health` prints the same `warnings`/`errors` arrays, so you can read the verdict after deploying.

The only `NEXT_PUBLIC_*` variables read anywhere are `NEXT_PUBLIC_GD_ENABLED` (`app/page.tsx:16`, `app/gd/page.tsx:25`)
and `NEXT_PUBLIC_STT_LANG` (`lib/stt.ts:217`). Both are optional and both are **inlined at build time** — changing them
in Vercel needs a redeploy, not just a restart. No other `process.env` read reaches the client bundle: every remaining
read is in `lib/*` server modules or `app/api/*` routes, and `lib/tts.ts` / `lib/tts-kokoro.ts` / `hooks/*` /
`components/*` read none.

## Vercel platform limits this app runs into

Verified against the Vercel docs on 2026-08-25 (`vercel.com/docs/functions/limitations`, last updated 2026-07-01):

| Limit | Vercel (Hobby, Fluid compute — default for new projects) | This app | Verdict |
|---|---|---|---|
| Function `maxDuration` | default **300 s**, maximum **300 s** on Hobby (800 s Pro/Enterprise). The old 60 s Hobby cap no longer applies. | `app/api/interview/route.ts:10` = 60, `app/api/tts/route.ts:39` = 60, `app/api/gd/route.ts:13` = 60, `app/api/stt/route.ts:9` = 30; every other route inherits the 300 s default | fine — all four are under the cap and are compiled into `.next/server/functions-config-manifest.json` |
| Request / response body | **4.5 MB** hard limit → `413 FUNCTION_PAYLOAD_TOO_LARGE` before your code runs | `/api/stt` caps `audio` at 4 MiB (`app/api/stt/route.ts:13`); real VAD segments are ~400 KB. `/api/sessions` caps at 512 KB (`:18`) | fine — the app's own cap is below Vercel's, so users see the app's `413 audio too large`, never Vercel's |
| Streaming responses | allowed; counted against `maxDuration` including the time spent streaming | `/api/interview` (SSE) and `/api/tts` (chunked WAV) both stream; a turn is < 1 s to last byte, a synthesis < 3 s | fine |
| Runtime | Node.js; new projects default to the latest LTS (**24.x**). Node 20 is **deprecated on 2026-10-01** | `package.json` `engines.node >= 20.3`; no `.nvmrc`; no `postinstall`; `next@15.5.20` | set the project's Node.js version to **22.x or 24.x** in *Settings → Build and Deployment*; do not pick 20.x |
| Middleware runtime | Node.js middleware is supported on Vercel for Next.js ≥ 15.5 | `middleware.ts:17` `runtime: "nodejs"`; the build writes it under `/_middleware` with `runtime: "nodejs"` and the 11 matchers in `functions-config-manifest.json` | fine — needed because `@upstash/*` and `lib/rate-limit.ts` use Node APIs |
| Function bundle size | **250 MB unzipped** per function (or up to 5 GB with *large functions*, on by default for new projects, `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` for old ones) | see the next section | **WARN** |
| Memory | Hobby: 2 GB / 1 vCPU | nothing here is memory-heavy server-side; the ML models run in the browser | fine |

### The on-device ML stack and the 250 MB function limit

`next.config.ts:23` lists `@huggingface/transformers`, `kokoro-js` and `onnxruntime-node` in `serverExternalPackages`
and `:31` aliases `onnxruntime-node` to `false` for the browser build. Reading the actual build output:

- **Client**: `KokoroTTS` / `onnxruntime-web` land in six lazily-loaded `.next/static/chunks/*.js` files
  (26–429 KB each), pulled in only by `lib/tts-kokoro.ts:59`'s `await import("kokoro-js")`. The `/interview` first-load
  JS is 156 KB; the ML chunks are not part of it. Correct.
- **Server**: the server bundle contains only a one-line stub `a.exports=import("kokoro-js")` (the externalized
  dynamic import). It is never executed: `ensureKokoroLoading()` returns immediately when `window` is undefined
  (`lib/tts-kokoro.ts:55`). Correct.
- **But the file trace is not small.** Because the package is *external*, Next.js's output-file tracing follows it on
  disk, and `@huggingface/transformers`' Node build requires `onnxruntime-node`, whose `bin/` directory ships native
  binaries for **every** platform (210 MB, of which linux/x64 — the only one a lambda can run — is 34 MB). Measured from
  `.next/server/app/*/page.js.nft.json` of this build:

  | Page function | traced files | traced size | of which ML packages |
  |---|---|---|---|
  | `/interview` | 394 | **220.6 MB** | 198.8 MB |
  | `/gd` | 393 | **220.5 MB** | 198.8 MB |
  | `/` | 332 | 95.0 MB | 71.7 MB |
  | `/report/[sessionId]`, `/dashboard`, every `/api/*` route, middleware | 42–57 | 0.7–1.3 MB | 0 |

  Those three pages are prerendered (`○` in the build log) and served statically, but Vercel still packages an
  App Router page function for them, grouped with the other pages. 220 MB is **under** the 250 MB limit — but with
  ~12 % headroom, and one more dependency in `app/interview/page.tsx`'s import graph tips it over and the build fails
  with `A Serverless Function has exceeded the unzipped maximum size of 250 MB`. This could not be exercised from this
  machine (no Vercel link), so it is reported as a risk, not a failure.

  **If the build fails with that error**, either of these fixes it without touching runtime behaviour:

  1. Add `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` as a project environment variable (raises the cap to 5 GB; it is already the
     default for projects created after the large-functions rollout).
  2. Preferably, stop tracing packages the server never runs — in `next.config.ts`:
     ```ts
     outputFileTracingExcludes: {
       "*": ["node_modules/onnxruntime-node/**", "node_modules/kokoro-js/**",
             "node_modules/@huggingface/transformers/**", "node_modules/onnxruntime-web/**"],
     },
     ```
     This is safe because the only server-side reference is the never-taken `import("kokoro-js")` stub above.

### The Kokoro model download from a Vercel-hosted page

`next.config.ts:3-15` deliberately sets **no Content-Security-Policy** and no `Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy`. Consequences, all verified by reading `node_modules/kokoro-js/dist/kokoro.web.js`:

- The ~90 MB model (`onnx-community/Kokoro-82M-v1.0-ONNX`, `lib/tts-kokoro.ts:29`) is fetched by the **browser
  directly from `huggingface.co`** (the default `remoteHost` of transformers.js), which serves permissive CORS headers.
  No CSP on our side blocks it, and the bytes never pass through a Vercel function — no bandwidth or function cost.
- WASM **threads are off**: with no COOP/COEP the page is not `crossOriginIsolated`, and onnxruntime-web then forces
  `numThreads = 1` (and prints a console warning if asked for more). Synthesis still works, single-threaded — slower on
  weak devices, but not broken. Enabling threads would require both headers on every response, which breaks the
  Monaco CDN loader and cross-origin audio; the trade-off in `next.config.ts` is the right one.
- **WebGPU** needs no headers. `lib/tts-kokoro.ts:37-46` only uses it when `navigator.gpu.requestAdapter()` returns
  an adapter, and `:61-67` falls back to WASM q8 if the WebGPU load throws.

The download is triggered early: the mic-check "continue" handler calls `resolveVoiceEngine()`
(`hooks/useInterviewMachine.ts:562`, `hooks/useGdMachine.ts:306`), which ends with `ensureKokoroLoading()` on every
path (`lib/tts.ts:198` and `:202`); `setVoiceEngine("kokoro")` at `lib/tts.ts:115` also starts it, and the landing page
calls `resolveVoiceEngine()` on load (`app/page.tsx:173`) — so the model is usually downloading before the candidate
has even chosen a round.

### What each kind of visitor gets on Vercel

On the deployed site `chatterboxUrl()` returns `null` (`app/api/tts/route.ts:60`, `NODE_ENV === "production"` with no
`CHATTERBOX_URL`), so `GET /api/tts` reports `chatterbox:false`, `cloud:"groq"`. In `resolveVoiceEngine()`
(`lib/tts.ts:186-193`) `"groq"` is in `METERED_CLOUD_ENGINES` (`:158`), so the auto-pick is **`"kokoro"`** — unless the
visitor explicitly picked another engine in the voice picker (`storedVoicePreference()`, a separate localStorage key,
`:90-98`).

| Visitor | Voice | Hearing |
|---|---|---|
| Desktop Chrome/Edge with a GPU | Kokoro on WebGPU (fp32). First visit waits for the ~90 MB download; a line that arrives before the model is ready is **held up to 8 s** (`KOKORO_WAIT_MS`, `lib/tts.ts:349`, `floorSpeak` `:365-368`), then spoken by the system voice — never a mid-reply voice change | `pickSttEngine()` (`lib/stt.ts:118-125`): `caps.cloud === "groq"` so **cloud Whisper** via `/api/stt`, in every browser, 2000 req/day |
| Desktop Firefox / Safari, no WebGPU | Kokoro on WASM q8, single-threaded (see above) | cloud Whisper |
| Phone (Android Chrome / iOS Safari) | Same chain. The 90 MB download and a single-threaded WASM model on a phone are the weak spot: expect a long first load and slow synthesis; if the load throws (memory), `status = "failed"` (`lib/tts-kokoro.ts:71`) and the session speaks with `speechSynthesis` (`systemSpeak`, `lib/tts.ts:822`) — the robotic voice, but one consistent voice. **Not measured on a real device.** | cloud Whisper (the on-device VAD segmenter works in every browser) |
| Anyone who picks "Cloud voice" in the picker | Groq Orpheus, 2 requests per turn, **100 requests/day for the whole deployment** — for demos only | — |

### Rate limiting on Vercel without Upstash

`middleware.ts:16-31` runs on every matched `/api/*` path and calls `checkRateLimit()`; with no `UPSTASH_REDIS_*` it
takes the in-memory path (`lib/rate-limit.ts:228` → `memoryCheck`, `:112-130`). The buckets are module-level `Map`s
(`:106-110`), i.e. **per function instance**. The honest consequence:

- Per-minute limits (30/min interview, 60/min tts, 120/min stt, 10/min login …) and the 400/day per-client LLM
  budget are enforced **only within one warm instance**. Fluid compute reuses instances, so a quiet site with one
  instance behaves as locally; under load, or after a cold start, each new instance starts every counter at zero.
  A determined client can exceed every limit by spreading requests over time; an honest user will never notice.
- The brute-force protection on `/api/auth/login|register` is likewise per-instance. With no `MONGODB_URI` there are
  no accounts to brute-force, so this is moot for the documented configuration.
- The `pds_client` cookie is still minted and validated (`middleware.ts:43-46`) and the 429 messages are unchanged.
- Nothing breaks and nothing 500s; `/api/health` reports `"rateLimit":"memory"` and the boot log carries the
  `UPSTASH_REDIS_* not set` warning. The real ceiling protecting the Groq key is Groq's own daily quota
  (1000 LLM / 2000 STT / 100 TTS requests), which is shared by everyone who uses the site.

This is not fixed here. A free Upstash Redis database plus the two env vars is the fix, and needs no code change.

### Secrets hygiene

`/api/health` (`app/api/health/route.ts:26-43`) returns only booleans and engine/model *names*; the probe output above
contains no key material. `/api/tts` and `/api/stt` GET report engine names only. `.gitignore` excludes `.env*` except
`.env.example`, and `.data/` (the JSON user store). No file in `app/ lib/ hooks/ components/` reads a non-`NEXT_PUBLIC_`
variable from client code (grep of `process.env.` on 2026-08-25).

## Exact Vercel steps for this repository

1. Put this folder in a Git repository (GitHub/GitLab/Bitbucket) or run `vercel link` from it — there is no `.git` and
   no `.vercel` here today, so a plain `git push` deploys nothing.
2. *Vercel → Add New Project* → import the repo. Framework preset **Next.js** is auto-detected; leave Build Command
   (`next build`), Output Directory (default) and Install Command (`npm install`, driven by the committed
   `package-lock.json`) at their defaults. There is no `vercel.json` and none is needed: `maxDuration` is exported per
   route and the middleware declares its own runtime.
3. *Settings → Build and Deployment → Node.js Version*: **22.x** or **24.x** (see the limits table).
4. *Settings → Environment Variables* (Production, and Preview if you use it):
   - `AUTH_JWT_SECRET` — 64 hex chars from `openssl rand -hex 32` (**required, ≥ 32 chars**)
   - `GROQ_API_KEY`
   - `SUPERMEMORY_API_KEY` (optional)
   - nothing else is needed. Do **not** set `CHATTERBOX_URL` (there is no local voice server on Vercel) and do not set
     `TTS_PROVIDER=groq` expecting it to become the automatic voice — the client still refuses metered engines.
5. Deploy, then run the three probes at the top of this document against the deployment URL. `/api/health` must show
   `"version":"1.2.0"`, `"ok":true`, `"llm":{"backend":"groq",…}`, `"stt":{"cloud":"groq"}`, `"errors":[]`.
6. Open the site in a browser, run a mic check, and confirm the room's voice chip says **On-device voice** after the
   first download. "Basic voice" for longer than ~10 s on a desktop means the Kokoro load failed — the browser console
   prints `[kokoro] on-device voice unavailable: …` with the reason.
7. If the build fails with the 250 MB function-size error, apply one of the two fixes in *The on-device ML stack and
   the 250 MB function limit* and redeploy.

## How the voice engine is chosen

`resolveVoiceEngine()` in `lib/tts.ts` picks **one** engine per session, in this order:

1. **Chatterbox** (`CHATTERBOX_URL`, or `http://127.0.0.1:8004` outside production) — the local
   [devnen/Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server). Unmetered, studio
   voices, and it performs paralinguistic tags (`[laugh]`, `[chuckle]`, `[sigh]` …). Best quality, but
   it only exists on a machine that is running it — never on Vercel.
2. **Kokoro-82M on-device** — runs in the browser via WebGPU/WASM. ~80 MB downloaded once and cached.
   No key, no quota, no network per utterance, and a single fixed speaker embedding, so its voice
   *cannot* drift. **This is the production voice.**
3. **A cloud engine**, but only one whose quota can survive a real interview.

Groq's Orpheus is deliberately **excluded from automatic selection**. Measured against the live API, the
free tier is:

```
x-ratelimit-limit-requests: 100      # per DAY (full refill ~24h)
x-ratelimit-limit-tokens:  1200      # per minute
```

100 requests/day is roughly two interviews. After that every line would fall to a different voice, which
is the exact bug this architecture was rebuilt to eliminate. Orpheus remains available as an explicit
pick in the voice picker for demos, where its warmth is worth the budget.

> **Consequence for the deployed site:** the interviewer speaks with Kokoro, and it works with **no API
> keys at all**. The first visit pays an ~80 MB model download, warmed during the mic check. That is why
> `GET /api/tts` reporting `cloud: null` on production is *not* a fault.

## Running Chatterbox locally (the good voices)

```powershell
git clone https://github.com/devnen/Chatterbox-TTS-Server
cd Chatterbox-TTS-Server
# follow that repo's setup; it serves on port 8004 by default
```

The app probes `http://127.0.0.1:8004/v1/audio/voices` and switches to it automatically when it answers.
Confirm with:

```powershell
Invoke-WebRequest "http://127.0.0.1:8004/v1/audio/voices" -UseBasicParsing
```

Set `CHATTERBOX_URL` if you run it on another host or port. Note that `chatterboxUrl()` in
`app/api/tts/route.ts` deliberately refuses to probe localhost when `NODE_ENV === "production"` — a
deployed server has no local voice server, and probing one on every request would just add latency.

## Release checklist

1. `npm run check` (typecheck + tests + build) passes locally.
2. Bump `lib/version.ts`, `VERSION` and `package.json` together — the version is how a deploy is
   identified, so it must change or the health probe cannot tell old from new.
3. Push / `vercel --prod`.
4. Run the three probes above against the deployed URL.
5. Confirm `/api/health` reports the version you just bumped to. If it does not, the deploy did not land
   — do not move on.
