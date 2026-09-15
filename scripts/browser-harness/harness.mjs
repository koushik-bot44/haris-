// Real-browser voice-session harness for the interview room.
//
//   node harness.mjs <mode> <baseUrl> <outDir>
//   mode: stt | probe | hr | tech        (SCENARIOS=a,b limits the stt list)
//
// Drives Google Chrome (playwright-core, channel "chrome"). The candidate's
// answers are Kokoro-synthesised WAVs played into the page's microphone (the
// harness replaces getUserMedia with an AudioContext destination stream), so
// the room's real VAD → /api/stt → engine path runs. The interviewer's own
// generated audio is captured from every AudioBufferSourceNode (Kokoro whole
// utterances, Chatterbox/cloud streamed chunks stitched per utterance) and
// saved, so what was actually SPOKEN can be transcribed. /api/stt can be made
// to fail per scenario.
// playwright-core is NOT a project dependency: `npm i --no-save playwright-core` (or
// point HARNESS_PW at an install) — Chrome itself is the user's installed Google Chrome.
import { createRequire } from "node:module";
const pw = createRequire(import.meta.url)(process.env.HARNESS_PW || "playwright-core");
const { chromium } = pw;
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [, , MODE, BASE = "http://127.0.0.1:3100", OUT = "./harness-out"] = process.argv;
setTimeout(() => { console.log("WATCHDOG: giving up"); process.exit(2); }, 40 * 60_000).unref();
const SCR = process.env.HARNESS_DIR || new URL(".", import.meta.url).pathname;
const BANK = join(SCR, "bank");
const PROFILE_DIR = process.env.PROFILE_DIR || join(SCR, "chrome-profile");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`; console.log(line); };

const PROFILE = { experienced: false, companies: [], skills: ["Java", "Spring Boot", "MySQL", "REST APIs"], projects: [{ name: "Campus Cart", summary: "student marketplace" }] };

/** Which spoken answer fits the question — varied so the same story is not repeated. */
const used = new Map();
function pickAnswer(round, q) {
  const l = q.toLowerCase();
  let keys;
  if (round === "technical") {
    keys = /what would you like to ask|questions for me|ask me anything you|anything you.d like to ask/.test(l) ? ["t_question"]
      : /ten times|scale|more (users|students)|load|break first/.test(l) ? ["t_scale"]
      : /complexity|space|time .*solution|your (code|solution|method|implementation)|edge case|empty|null/.test(l) ? ["t_complexity"]
      : /hashmap|hash map|bucket|collision/.test(l) ? ["t_hashmap"]
      : /string|immutable|jvm|garbage|memory|arraylist|linked ?list|primitive|wrapper|sealed|record/.test(l) ? ["t_strings", "t_dontknow"]
      : /polymorph|interface|abstract|inherit|oop|solid|design pattern|class/.test(l) ? ["t_poly", "t_interface"]
      : /heap|top (ten|k)|million|cycle|pointer|algorithm|sort|search|big o|complex/.test(l) ? ["t_topk", "t_cycle"]
      : /why .*(spring|choose|chose|pick|decid)|alternative|instead of|framework|node/.test(l) ? ["t_why_spring"]
      : /bug|hardest|broke|problem you hit|challeng|difficult|race|uniqueness|constraint|conflict|concurren/.test(l) ? ["t_hardest_bug"]
      : /project|built|campus|backend|api|your part|which part|proud/.test(l) ? ["t_project", "t_why_spring", "t_hardest_bug"]
      : ["t_generic", "t_dontknow"];
  } else {
    keys = /what would you like to ask|questions for me|ask me anything you|anything you.d like to ask/.test(l) ? ["h_question"]
      : /yourself|introduce|background|about you|relevant/.test(l) ? ["h_intro"]
      : /disagree|conflict|teammate|colleague|team .*(work|coordinat|align)/.test(l) ? ["h_team", "h_contradict"]
      : /initiative|responsib|without being asked|owned|ownership|decid/.test(l) ? ["h_own"]
      : /learn|new (tool|skill|technolog)|quickly|adapt|unfamiliar|docker|curve/.test(l) ? ["h_learn"]
      : /why (this|the) role|motivat|first year|five years|three years|programme|career|attract|why now|hoping/.test(l) ? ["h_motiv"]
      : /weak|improve|feedback|criticism|failure|mistake|strength/.test(l) ? ["h_weak"]
      : /pressure|deadline|stress|urgent|broke|overwhelm|calm/.test(l) ? ["h_pressure"]
      : /relocat|package|salary|notice|joining|location/.test(l) ? ["h_logistics"]
      : ["h_generic"];
  }
  const n = used.get(keys[0]) ?? 0;
  used.set(keys[0], n + 1);
  return keys[Math.min(n, keys.length - 1)];
}

const CODE = "public class Solution {\n  public static boolean isBalanced(String s) {\n    java.util.Deque<Character> st = new java.util.ArrayDeque<>();\n    for (char c : s.toCharArray()) {\n      if (c=='('||c=='['||c=='{') st.push(c);\n      else { if (st.isEmpty()) return false; char o = st.pop(); if ((c==')'&&o!='(')||(c==']'&&o!='[')||(c=='}'&&o!='{')) return false; }\n    }\n    return st.isEmpty(); // O(n) time, O(n) space\n  }\n}";

async function launch() {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: true,
    viewport: { width: 1200, height: 900 },
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-webgpu", "--enable-features=Vulkan"],
    permissions: ["microphone"],
    // A protected Vercel Preview: the project's automation bypass token, from
    // the environment so it never lands in a file.
    ...(process.env.VERCEL_BYPASS ? { extraHTTPHeaders: { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS } } : {}),
  });
}

/** Everything the page needs before any app script runs. */
const INIT = `
(() => {
  try { sessionStorage.setItem("pds_barge_in_room", "off"); sessionStorage.setItem("pds_code_lang", "java"); } catch {}
  try { if (window.__profile) sessionStorage.setItem("pds_resume_profile", JSON.stringify(window.__profile)); } catch {}
  // A previous session's resume state would turn the mic check into a
  // "Welcome back" banner; only the reload test wants that.
  try { if (!window.__keepResume) localStorage.removeItem("pds_room_resume"); } catch {}
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  window.__mic = {
    async speak(url) {
      const ab = await (await fetch(url)).arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest); src.start();
      return buf.duration;
    },
  };
  navigator.mediaDevices.getUserMedia = async () => dest.stream.clone();
  // Capture what the INTERVIEWER speaks: every buffer started on any context
  // other than the fake mic's. A streamed line arrives as many small buffers
  // scheduled back to back, an on-device line as one; both are stitched into
  // one clip per utterance (a new utterance starts after a 1.5 s gap),
  // down-sampled to 16 kHz for transcription, capped at 40 s.
  window.__spoken = [];
  let utt = null;
  const flush = () => {
    if (!utt || utt.n === 0) return;
    const pcm = new Int16Array(utt.n); let o = 0; for (const p of utt.parts) { pcm.set(p, o); o += p.length; }
    let bin = ""; const bytes = new Uint8Array(pcm.buffer); for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    window.__spoken.push({ t: utt.t, seconds: utt.n / 16000, rate: 16000, b64: btoa(bin), chunks: utt.parts.length });
    if (window.__spoken.length > 40) window.__spoken.shift();
    utt = null;
  };
  window.__flushSpoken = flush;
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    try {
      const b = this.buffer;
      if (b && this.context !== ctx) {
        const now = Date.now();
        if (utt && now - utt.last > 1500) flush();
        if (!utt) utt = { t: now, last: now, n: 0, parts: [] };
        const ch = b.getChannelData(0);
        const step = b.sampleRate / 16000; const n = Math.min(Math.floor(ch.length / step), Math.max(0, 16000 * 40 - utt.n));
        const pcm = new Int16Array(n); for (let i = 0; i < n; i++) { const v = ch[Math.floor(i * step)]; pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767))); }
        utt.parts.push(pcm); utt.n += n; utt.last = now + Math.round(b.duration * 1000);
      }
    } catch {}
    return origStart.apply(this, args);
  };
  window.__speechSynth = 0;
  const origSpeak = window.speechSynthesis && window.speechSynthesis.speak;
  if (origSpeak) window.speechSynthesis.speak = function (u) { window.__speechSynth++; return origSpeak.call(this, u); };
})();`;

function wav16(pcmB64) {
  const pcm = Buffer.from(pcmB64, "base64");
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + pcm.length, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(pcm.length, 40); pcm.copy(buf, 44);
  return buf;
}

async function transcribe(wavBuf) {
  const form = new FormData();
  form.append("audio", new Blob([wavBuf], { type: "audio/wav" }), "clip.wav");
  const r = await fetch(`${BASE}/api/stt`, { method: "POST", body: form, headers: process.env.VERCEL_BYPASS ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS } : {} });
  if (!r.ok) return `<stt ${r.status}>`;
  return (await r.json()).text ?? "";
}

/** One interview session. `sttMode` controls how /api/stt behaves after Start. */
async function session(ctx, { round, role, name, sttMode = "pass", maxTurns = 30, reloadAt = null, tag }) {
  const page = await ctx.newPage();
  const questions = []; const answers = []; const events = []; const requests = []; const ttsClips = [];
  let sttFailArmed = false; let sttCalls = 0;
  await page.addInitScript(`window.__profile = ${JSON.stringify(round === "technical" ? PROFILE : null)}; window.__keepResume = ${reloadAt !== null};`);
  await page.addInitScript(INIT);
  page.on("console", (m) => { const t = m.text(); if (/error|kokoro|\[tts\]|\[stt\]|\[interview\]|onnx/i.test(t) && !/W:onnxruntime|favicon/.test(t)) events.push(`console: ${t.slice(0, 220)}`); });
  page.on("pageerror", (e) => events.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on("requestfailed", (r) => { const u = r.url(); if (/jsdelivr|huggingface|onnx|wasm|kokoro|\/api\//i.test(u)) events.push(`requestfailed: ${u.slice(0, 140)} ${r.failure()?.errorText ?? ""}`); });
  await page.route("**/__wav/*", async (route) => {
    const file = join(BANK, route.request().url().split("/__wav/")[1]);
    route.fulfill({ status: 200, contentType: "audio/wav", body: readFileSync(file) });
  });
  // Block ONLY the Monaco CDN so the plain textarea takes over — a coding
  // answer never depends on a CDN here. Kokoro's runtime also comes from
  // jsdelivr, so a blanket block would push every session onto the system voice.
  await page.route("**/cdn.jsdelivr.net/npm/monaco-editor**", (route) => route.abort());
  await page.route("**/api/stt", async (route) => {
    sttCalls++;
    const n = sttCalls;
    if (!sttFailArmed || sttMode === "pass") return route.continue();
    if (sttMode === "empty") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "" }) });
    if (sttMode === "fail-once") { if (n === sttFailArmed) return route.fulfill({ status: 500, body: "boom" }); return route.continue(); }
    if (sttMode === "fail-all") return route.fulfill({ status: 500, body: "boom" });
    if (sttMode === "rate-limited") return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "stt_rate_limited" }) });
    if (sttMode === "partial") { if (n === sttFailArmed) return route.continue(); return route.fulfill({ status: 500, body: "boom" }); }
    if (sttMode === "timeout-once") { if (n === sttFailArmed) { await sleep(16_000); } return route.continue(); }
    return route.continue();
  });
  page.on("request", (req) => { if (req.url().includes("/api/interview") && req.method() === "POST") { try { const b = JSON.parse(req.postData() || "{}"); requests.push({ t: Date.now(), speculative: !!b.speculative, history: b.history?.length ?? 0, hasState: typeof b.state === "string", last: b.history?.[b.history.length - 1] ?? null, voiceEngine: b.voiceEngine, transcript: (b.history ?? []).map((h) => `${h.speaker === "interviewer" ? "Q" : "A"}: ${h.text}`) }); } catch {} } });
  page.on("response", async (res) => {
    if (!res.url().includes("/api/tts") || res.request().method() !== "POST") return;
    try { let text = ""; try { text = JSON.parse(res.request().postData() || "{}").text ?? ""; } catch {} ttsClips.push({ t: Date.now(), status: res.status(), engine: res.headers()["x-tts-engine"] ?? null, text }); } catch {}
  });
  page.on("response", async (res) => {
    if (!res.url().includes("/api/interview")) return;
    try {
      const text = await res.text();
      let turn = null;
      if (text.startsWith("data:")) { for (const f of text.split("\n\n")) { if (!f.startsWith("data: ")) continue; const ev = JSON.parse(f.slice(6)); if (ev.kind === "turn") turn = ev; } }
      else turn = JSON.parse(text);
      if (turn?.turn?.text) { questions.push({ t: Date.now(), text: turn.turn.text, scripted: !!turn.turn.scripted, coding: !!turn.turn.coding, done: !!turn.turn.done, view: turn.view ? { current: turn.view.current, progress: turn.view.progress } : null, report: turn.report ?? null }); }
    } catch {}
  });

  const url = `${BASE}/interview?name=${encodeURIComponent(name)}&role=${role}&round=${round}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const micCheck = async () => {
    await page.getByRole("button", { name: "Enable microphone" }).click({ timeout: 20_000 });
    await sleep(800);
    // The mic can open a few seconds after the click (capability probe, a cold
    // route compile); a sentence spoken before that is simply never heard.
    let heard = false;
    for (let attempt = 1; attempt <= 4 && !heard; attempt++) {
      await page.evaluate(() => window.__mic.speak("/__wav/h_generic.wav"));
      heard = await page.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find((x) => /Sounds right/.test(x.textContent || "")); return Boolean(b && !b.disabled); }, null, { timeout: 15_000, polling: 300 }).then(() => true).catch(() => false);
      if (!heard) { log(tag, `mic check: nothing heard on attempt ${attempt}, speaking again`); events.push(`mic-check-retry:${attempt}`); }
    }
    await page.getByRole("button", { name: "Sounds right — continue" }).click({ timeout: 10_000 });
    log(tag, "mic check passed");
    const t = Date.now();
    await page.getByRole("button", { name: "Start the interview" }).click({ timeout: 360_000 });
    events.push(`voice-ready-after:${Math.round((Date.now() - t) / 1000)}s engine:${await page.evaluate(() => { try { return localStorage.getItem("pds_voice_engine"); } catch { return null; } })}`);
    log(tag, "started");
  };
  await micCheck();
  sttFailArmed = sttCalls + 1; // failures apply from the first answer onward
  const t0 = Date.now();
  let turns = 0; let reloaded = false;
  while (turns < maxTurns && Date.now() - t0 < 30 * 60_000) {
    const state = await page.waitForFunction(() => {
      const body = document.body.innerText;
      if (/Round complete/.test(body)) return "done";
      if (/lost connection|out of capacity/.test(body)) return "lost";
      if (document.querySelector("[data-end-answer]")) return "listening";
      if (document.querySelector(".code-pane")) return "coding";
      if (document.querySelector("textarea#answer")) return "text";
      return false;
    }, null, { timeout: 240_000, polling: 500 }).then((h) => h.jsonValue()).catch(() => "stuck");
    if (state === "done") { log(tag, "DONE"); break; }
    if (state === "stuck" || state === "lost") { events.push(`state:${state}`); await page.screenshot({ path: join(OUT, `${tag}-${state}.png`) }).catch(() => {}); if (state === "lost") { await page.getByRole("button", { name: "Try again" }).click().catch(() => {}); continue; } break; }
    const caption = (await page.locator(".caption").textContent().catch(() => "")) || "";
    const lastQ = questions[questions.length - 1]?.text ?? caption;
    turns++;
    const engineNow = await page.evaluate(() => { try { return localStorage.getItem("pds_voice_engine"); } catch { return null; } }).catch(() => null);
    events.push(`turn:${turns} responses:${questions.length} engine:${engineNow} caption:${caption.replace(/\s+/g, " ").slice(0, 120)}`);
    if (state === "coding") {
      log(tag, `#${turns} CODING turn`);
      await page.locator('textarea[aria-label="Code editor"]').waitFor({ timeout: 20_000 });
      await page.locator('textarea[aria-label="Code editor"]').fill(CODE);
      await page.getByRole("button", { name: "Submit code" }).click();
      answers.push({ key: "code", text: "<code>" });
      continue;
    }
    if (state === "text") { log(tag, `#${turns} room fell to TEXT MODE`); events.push("text-mode"); await page.locator("textarea#answer").fill("I did the backend part of Campus Cart."); await page.getByRole("button", { name: "Submit answer" }).click(); continue; }
    if (reloadAt !== null && turns === reloadAt && !reloaded) {
      reloaded = true;
      log(tag, `#${turns} RELOADING mid-answer to test resume`);
      await page.reload({ waitUntil: "domcontentloaded" });
      const welcome = await page.locator("text=Welcome back").isVisible({ timeout: 15_000 }).catch(() => false);
      events.push(`resume-banner:${welcome}`);
      await micCheck();
      continue;
    }
    const key = pickAnswer(round, lastQ);
    log(tag, `#${turns} Q: ${lastQ.replace(/\s+/g, " ").slice(0, 150)}`);
    log(tag, `#${turns} A: ${key}`);
    const dur = await page.evaluate((k) => window.__mic.speak(`/__wav/${k}.wav`), key);
    answers.push({ key, seconds: dur, question: lastQ });
    await page.waitForFunction(() => !document.querySelector("[data-end-answer]"), null, { timeout: Math.max(60_000, dur * 1000 + 45_000), polling: 300 }).catch(() => events.push("answer never closed"));
    await sleep(500);
  }
  const spoken = await page.evaluate(() => { try { window.__flushSpoken(); } catch {} return window.__spoken; }).catch(() => []);
  const speechSynth = await page.evaluate(() => window.__speechSynth).catch(() => -1);
  const body = await page.locator("body").innerText().catch(() => "");
  await page.screenshot({ path: join(OUT, `${tag}-final.png`), fullPage: true }).catch(() => {});
  await page.close();
  return { questions, answers, requests, events, spoken, ttsClips, speechSynth, finalBody: body.slice(0, 4000) };
}

/** Save and transcribe the interviewer's generated audio (one clip per
 * utterance, any engine). Paced for Groq Whisper's 20 requests/minute. */
async function verifySpoken(spoken, tag, n = 6) {
  const out = [];
  for (const c of spoken.filter((c) => c.seconds > 0.4).slice(0, n)) {
    const file = join(OUT, `${tag}-spoken-${out.length + 1}.wav`);
    const wav = wav16(c.b64);
    writeFileSync(file, wav);
    await sleep(3_600);
    out.push({ seconds: Math.round(c.seconds * 10) / 10, buffers: c.chunks ?? 1, heard: await transcribe(wav) });
  }
  return out;
}

function summarise(r, tag) {
  log(tag, `questions: ${r.questions.length} (fallback ${r.questions.filter((q) => q.scripted).length}) | answers: ${r.answers.length} | speechSynthesis calls: ${r.speechSynth} | tts: ${r.ttsClips.length} (${r.ttsClips.filter((c) => c.status !== 200).length} non-200)`);
  for (const [i, q] of r.questions.entries()) log(`${String(i).padStart(2)} ${q.scripted ? "[FB]" : "[M] "} ${q.view ? `${q.view.current}|${q.view.progress}` : ""} ${q.text.replace(/\s+/g, " ").slice(0, 220)}`);
  log("events:", r.events.filter((e) => !/kokoro\] WebGPU/.test(e)).join("\n   ").slice(0, 3000));
}

const ctx = await launch();
try {
  if (MODE === "stt") {
    const results = {};
    for (const mode of (process.env.SCENARIOS ? process.env.SCENARIOS.split(",") : ["pass", "fail-once", "empty", "partial", "timeout-once", "rate-limited"])) {
      log(`=== STT scenario: ${mode} ===`);
      try {
        const r = await session(ctx, { round: "technical", role: "java", name: "Asha Rao", sttMode: mode, maxTurns: 3, tag: `stt-${mode}` });
        const recorded = r.requests.filter((q) => q.last?.speaker === "candidate").map((q) => `${q.speculative ? "[spec] " : ""}${q.last.text}`);
        results[mode] = { questions: r.questions.map((q) => (q.scripted ? "[FB] " : "") + q.text), recorded, answers: r.answers.map((a) => a.key), events: r.events, speechSynth: r.speechSynth };
        log(mode, "recorded:", JSON.stringify(recorded).slice(0, 700));
        log(mode, "next Qs:", JSON.stringify(results[mode].questions.slice(1)).slice(0, 600));
        log(mode, "events:", r.events.filter((e) => /^turn:|mic-check|text-mode|state:|voice-ready|\[tts\]|\[stt\]/.test(e)).join(" || ").slice(0, 900));
      } catch (e) {
        results[mode] = { error: String(e).slice(0, 300) };
        log(mode, "SCENARIO FAILED:", String(e).slice(0, 200));
      }
      writeFileSync(join(OUT, "stt-results.json"), JSON.stringify(results, null, 1));
    }
  } else if (MODE === "probe") {
    const r = await session(ctx, { round: "technical", role: "java", name: "Probe", maxTurns: 2, tag: "probe" });
    summarise(r, "probe");
    log("first lines as heard:", JSON.stringify(await verifySpoken(r.spoken, "probe", 3)));
  } else if (MODE === "hr" || MODE === "tech") {
    const round = MODE === "hr" ? "hr" : "technical";
    const r = await session(ctx, { round, role: MODE === "hr" ? "hr-behavioural" : "java", name: MODE === "hr" ? "Ravi Kumar" : "Asha Rao", maxTurns: 24, reloadAt: MODE === "hr" ? 4 : null, tag: MODE });
    const spokenCheck = await verifySpoken(r.spoken, MODE, 6);
    writeFileSync(join(OUT, `${MODE}-results.json`), JSON.stringify({ ...r, spoken: undefined, spokenCheck }, null, 1));
    summarise(r, MODE);
    log("spoken audio check:", JSON.stringify(spokenCheck));
    if (r.questions.at(-1)?.report) log("REPORT:", JSON.stringify({ verdict: r.questions.at(-1).report.verdict, overall: r.questions.at(-1).report.overall }));
  }
} finally {
  await ctx.close();
}
