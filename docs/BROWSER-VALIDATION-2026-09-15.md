# Real-browser voice validation — 2026-09-15

Branch `feat/orb-and-conversation-engine`, validated at `28a25a1` (+ harness commit `5da6894`).
Production (`main` = `99badd2`, the July build) was not touched. Harness: `scripts/browser-harness/`
(headless Google Chrome 152, fake microphone fed with Kokoro-spoken answers, real VAD → `/api/stt`
(Groq Whisper) → engine → `/api/tts` (local Chatterbox) with the on-device voice as fallback).

## What was fixed on the way (all pushed, each with tests)

| Commit | Fix | Found by |
|---|---|---|
| `7290449` | A recogniser failure is no longer "the candidate said nothing": `(unheard)` / `(part of the answer was not captured)`, 12 s segment timeout + one retry, the room waits for in-flight segments, a late segment lands where it was *spoken* (was appended where it *arrived* → "…never happened again. The hardest part was…"), Groq 429 → 429 `stt_rate_limited` → next engine immediately. | timeout scenario transcript |
| `de10877` | Studio voice from the candidate's own machine even on Vercel: the page probes `127.0.0.1:8004` when the deployed server reports none; one shared request shape (`lib/chatterbox-request.ts`) for route and browser. | production probe: old build only *labelled* "Studio voice" |
| `8fa4d8c` | A slow Chatterbox render no longer becomes a second voice: `play()` waits for the in-flight render instead of rendering the same line twice; the route budget covers time-to-first-byte only (a fixed 20 s cut truncated long lines). | probe run: `POST /api/tts 502 in 20051ms` then "REST OF THIS SESSION uses the on-device voice" |
| `a3ad38c` | Acks render *after* the opening line (they were queued in front of it on the single-threaded server); every server-voice fetch goes through `fetchServerVoice()` so the direct path covers acks too. | second probe: greeting waited 55 s behind five ack renders |
| `28a25a1` | The on-device fallback no longer warms on the same GPU while Chatterbox renders the opening line. | Chatterbox log: 44–85 s renders at every session start, 1–5 s otherwise |
| `f95498d` | "heh-heh" dropped from the expression library (Whisper hears "head-head"). | ASR round-trip |

## STT-failure scenarios (technical round, 3 turns each, `/api/stt` intercepted after Start)

| Scenario | What the server was asked to read | Interviewer's next line | Verdict |
|---|---|---|---|
| pass | full answers, in order | follow-up on the API design | ✓ |
| fail-once (500 on one segment, retry succeeds) | "…so only **Only one order can exist per listing**, and after that it never happened again." — the retried segment back in place | "Okay, that sounds like a solid fix. Can you walk me through how you implemented that unique check…" | ✓ no re-ask |
| empty (200, no words) | `(unheard)` | "I didn't catch that, could you please repeat what your project does and which part you built?" then "I'm sorry, I didn't catch that. Could you please say it again?" | ✓ asks to repeat, never "you were silent" |
| partial (first segment ok, rest 500) | "…buy and sell used books and cycles. **(part of the answer was not captured)**", then `(unheard)` | "Okay, can you tell me which parts of Campus Cart you actually built yourself…" then "I didn't catch that—could you please repeat which parts…" | ✓ works with what came through |
| timeout-once (one segment held 16 s) | full answer in the right order (was tail-before-head before the fix) | "Hmm. Staying with that — walk me through how that actually worked, step by step." (fallback move) → "Okay, let's shift to Java itself…" | ✓ |
| rate-limited (429 from `/api/stt`) | room handed over to the next recogniser at once; the fake-mic audio through Chrome's own recogniser came back as "company", "call accounting", "ado" | "you mentioned "company" just now—could you walk me through the Campus Cart project…" | ✓ handover works; ⚠ Chrome's recogniser on this synthetic audio is poor — with a real mic it is the same engine the mic check offers |

Repetition on failure: none. In every scenario the next line was a new question or an honest "I didn't catch that", never the same question re-put as if unanswered.

## HR round (Ravi Kumar, `hr-behavioural`, 15 answers, reload at turn 4)

- 12 interviewer turns from the model, **0 fallback**, `Round complete` — verdict **ALMOST READY 6.8/10 across 7 assessed competencies**, evidence quotes present.
- Competency path: communication → adaptability → self-awareness → motivation → teamwork → candidate questions → close; coverage 0 → 1.0; never more than 3 consecutive turns on one competency.
- `findRepeats` over the final 15 interviewer lines: **exact 0, reworded 0**.
- Evidence-based contradiction fired correctly: after "Actually in that project I was just a team member… I mostly worked on the frontend pages" → "Earlier you mentioned that you handled the back end and the notifications, and about 600 students used it… Just now you said you mostly worked on the front-end pages. Can you clarify…".
- The interviewer noticed a re-told story ("thanks for sharing that again") and rephrased an unanswered question instead of moving on — both correct; the harness picked a stale answer in those turns.
- Reload at turn 4: the pending question was spoken again and the round continued with its state (signed token present on every later request, coverage kept climbing). ⚠ the harness did not find the text "Welcome back", so the banner wording differs or was not shown — the *resume itself* worked.
- Voice: `speechSynthesis` calls **0** (never robotic). Chatterbox rendered the opening lines in **172 s / 81 s / 78 s / 167 s** on this loaded machine → 502 at the 45 s budget → the session latched onto the on-device voice, which then spoke every line clearly (captured audio transcribed verbatim: "You mentioned you got the container running just in time. What did you do to make sure that setup would stay reliable…"). Later Chatterbox renders were 3–20 s. See "Environment".

## Environment (this Mac, during the runs)

15 GB of 16 GB used, 255 MB free, 6.6 GB compressed, with Chatterbox (3.8 GB model on MPS), two `next dev`
servers, headless Chrome and the on-device model resident. Chatterbox renders swung from 1–5 s (quiet) to
60–170 s (session start), i.e. slower than real time. The code changes above stop a slow render from
*changing the voice mid-session* on a normal machine; they cannot make a swapped-out model render faster.
For a demo on this Mac: close the second dev server and Chrome tabs before starting, or accept the
on-device voice.

Also learned the hard way: two `next dev` processes in one checkout share `.next/`; a third clobbered
both. The harness server now runs from a git worktree.

## localhost vs Vercel

| | localhost (`:3100` / your `:3000`) | Preview `p1dd6v85x` (Vercel, `5da6894`) |
|---|---|---|
| `GET /api/tts` | `chatterbox:true`, 28 voices, `chatterboxVoice:"Emily.wav"` | `chatterbox:false`, `cloud:"groq"` (metered, never auto-picked), `chatterboxVoice:"Emily.wav"` |
| engine the page settles on | **chatterbox** (Studio voice) | on-device (Kokoro) — **or chatterbox via the direct loopback path** when the browser's own machine runs the server (Chrome asks once for local-network access) |
| `GET /api/health` | ok, `llama-3.3-70b-versatile` | ok, `llama-3.3-70b-versatile`, `db:false` (no MongoDB on Preview → guest mode) |
| old production (`main`) | — | `chatterbox:false`, label hard-coded to "Studio voice", audio was Kokoro |

The Preview is behind Vercel Authentication, so the headless harness could not drive it; the direct
loopback path is covered by unit tests (`test/voice-engine-resolution.test.ts`) and needs one manual
check in a logged-in Chrome on the machine that runs Chatterbox.

## Technical round (Asha Rao, `java`, 17 answers, `LLM_CHAOS_429=0.35` on the harness server)

- 35 % of model calls were made to fail with a 429 before leaving the machine (`[llm] groq main model rate-limited, retrying on openai/gpt-oss-20b` in the server log). Result: 15 interviewer turns, **9 of them from the deterministic fallback**, coding editor opened at the right time, code reviewed, hand-over, candidate question answered, `Round complete` — verdict **NEEDS PRACTICE**.
- `findRepeats` over the final 17 interviewer lines: **exact 0, reworded 0**. The fallback kept the thread ("Staying on that — what did you rule out before you settled on that?"), referenced earlier answers ("Since you mentioned you haven't used joins…", "On REST APIs from your resume…") and moved competency when one was spent — it remembered the conversation while the model was unavailable.
- Competency path: projects → java → problem-solving (coding + review) → oop → dsa → databases → backend-apis → candidate questions → close.
- Voice: **Chatterbox for the entire round** ("Studio voice" chip at the end), `speechSynthesis` 0; 39 × 200 and 3 × 502 on `/api/tts`, none on the live path, so no voice switch. The captured audio transcribed verbatim, e.g. "Okay, let's take that one step further. Staying with that, what was the hardest problem you hit there and how did you get past it?" — the natural expressions ("Uh-huh.", "Hmm, okay.") render as words, not letters.
- One cosmetic fallback glitch seen: "Hmm, okay. Okay, different topic." (reaction and transition both start with "okay") — fixed in the same push.

## Remaining / not done

- The Preview could not be driven by the headless harness (Vercel Authentication); the direct-to-local-Chatterbox path on Vercel is unit-tested, not browser-tested. One manual check needed: open the Preview in Chrome on the Mac running Chatterbox, allow "local network" when asked, confirm the chip says "Studio voice".
- After two consecutive `(unheard)` answers the interviewer keeps asking to repeat; offering text mode at that point would be kinder.
- Chrome's own recogniser (the engine the room falls to after a Groq 429) transcribed the harness's synthetic audio badly; unverified with a real microphone.
- `CHATTERBOX_VOICE` only applies when the client sends a persona key; the room sends a wav filename, so the technical round uses Michael.wav regardless (pre-existing).
