// Cross-verify interviewer expressions against the PRODUCTION voice.
//
// Kokoro-82M is what the deployed app speaks with (on-device, in the browser),
// and the same model runs in Node. For every candidate expression this prints
// the phonemes the engine actually receives and measures the clip it produces:
// duration, loudness and how much of it is silence. A spelled-out reading
// ("ɛm ɛm" for "Mm") or a near-silent clip means the engine did not understand
// the expression — keep only what survives here. lib/expressions.ts records
// the results of the 2026-09-14 run.
//
//   node scripts/verify-expressions.mjs            # table on stdout
//   node scripts/verify-expressions.mjs ./out      # also writes .wav files to listen to
//
// First run downloads the ~90 MB q8 model from huggingface.co (cached after).

import { KokoroTTS } from "kokoro-js";
import { phonemize } from "phonemizer";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.argv[2];
const VOICES = ["af_heart", "am_michael"]; // the app's HR and technical Kokoro voices

const EXPRESSIONS = [
  "Okay.", "Okay, that makes sense.", "Tell me more about that.",
  "Hmm, okay.", "Hmm, okay...", "Oh, I see.", "Right.", "Right...", "Got it.", "Interesting.", "I see what you mean.", "Ah, okay.", "Alright.",
  "Yeah, fair enough.", "That's a good point.", "Okay, I follow.", "Let me understand that correctly...", "Just to clarify...", "So, you're saying...?",
  "Interesting — tell me more about that.", "Okay, let's dig into that.", "Alright, let's take that one step further.", "Wait, really?", "Oh, that's interesting.",
  "Hmm... I want to come back to that.", "Hmm... okay, that makes sense.",
  "Hmm.", "Hmm...", "Mm.", "Mm-hm.", "Mm-hmm.", "Mm-hm — go on?", "Mhm.", "Hm.", "Uh-huh.", "Uh huh.", "Uh...", "Um...", "Um, okay.",
  "Oh!", "Oh.", "Ah.", "Ah, right.", "heh-heh", "Heh.", "haha", "Ha ha.", "Ha!", "Haha, fair enough.", "That's funny.", "Well...", "So...", "Huh.", "Huh, interesting.",
  "[laugh]", "[chuckle]", "(laughs)", "*laughs*", "Mm, okay.", "Got it, one moment.", "Want me to rephrase that?",
];

function stats(audio, rate) {
  const n = audio.length;
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(audio[i]);
    sum += v * v;
    if (v > peak) peak = v;
  }
  const frame = Math.round(rate * 0.02);
  let silent = 0;
  let frames = 0;
  for (let i = 0; i + frame <= n; i += frame) {
    let s = 0;
    for (let j = i; j < i + frame; j++) s += audio[j] * audio[j];
    frames++;
    if (Math.sqrt(s / frame) < 0.003) silent++;
  }
  return { seconds: Math.round((n / rate) * 100) / 100, rms: Math.round(Math.sqrt(sum / Math.max(1, n)) * 1000) / 1000, silentPct: frames ? Math.round((silent / frames) * 100) : 100 };
}

/** The phonemizer spells unknown tokens as letter names — that is the bug. */
const LETTER_NAMES = /ɛm|eɪtʃ|ˈæstɚɹˌɪsk/;

if (OUT) mkdirSync(OUT, { recursive: true });
const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
const rows = [];
for (const text of EXPRESSIONS) {
  let ph = "";
  try {
    const p = await phonemize(text, "en-us");
    ph = Array.isArray(p) ? p.join(" | ") : String(p);
  } catch (e) {
    ph = `ERR ${e.message}`;
  }
  const row = { text, phonemes: ph, spelledOut: LETTER_NAMES.test(ph) };
  for (const voice of VOICES) {
    const a = await tts.generate(text, { voice });
    row[voice] = stats(a.audio, a.sampling_rate);
    if (OUT && voice === VOICES[0]) a.save(`${OUT}/${text.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}.wav`);
  }
  rows.push(row);
  const f = row[VOICES[0]];
  console.log(`${row.spelledOut ? "SPELLED " : "ok      "} ${JSON.stringify(text).padEnd(44)} ${ph.padEnd(36).slice(0, 36)} ${f.seconds}s rms=${f.rms} silence=${f.silentPct}%`);
}
if (OUT) writeFileSync(`${OUT}/verify-expressions.json`, JSON.stringify(rows, null, 1));
console.log(`\n${rows.filter((r) => r.spelledOut).length} of ${rows.length} expressions are spelled out by the phonemizer and must not be used with this voice.`);
