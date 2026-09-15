// The candidate's answer bank as spoken audio (Kokoro, a different voice from
// the interviewer), one 48 kHz mono WAV per answer, for the browser harness to
// play into the room's microphone.
import { KokoroTTS } from "kokoro-js";
import { writeFileSync, mkdirSync } from "node:fs";
const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });
const RATE = 48_000;
function resample(audio, from, to) {
  if (from === to) return audio;
  const n = Math.round((audio.length * to) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * from) / to; const i0 = Math.floor(x); const i1 = Math.min(audio.length - 1, i0 + 1); out[i] = audio[i0] + (audio[i1] - audio[i0]) * (x - i0); }
  return out;
}
function wav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}
const BANK = {
  t_project: "So the main project I did was Campus Cart, it's basically a place where students in my college can buy and sell used books and cycles. I did the whole backend part, the login and the listing pages talk to my APIs, and my friend did the design side.",
  t_why_spring: "I picked Spring Boot because we had learnt Java in college and I wanted something where the setup is quick, and honestly the auto configuration saved us a lot of time. The reason I did not go with Node was that nobody in the team knew JavaScript properly.",
  t_hardest_bug: "The hardest part was when two students tried to buy the same item at the same time, both got success messages. I fixed it by adding a unique check in the database so only one order can exist per listing, and after that it never happened again.",
  t_hashmap: "A HashMap works by hashing the key and putting it into a bucket, and if two keys land in the same bucket it keeps them in a small list, and in newer Java versions it becomes a tree when the list gets long. So mostly lookups are constant time.",
  t_strings: "Strings are immutable in Java so that they can be safely shared, like in the string pool, and also because the hash code can be cached, which is why they are good as map keys.",
  t_poly: "Polymorphism is when the same method call behaves differently depending on the object. In Campus Cart I had a Payment interface and two classes, one for UPI and one for cash on delivery, and the order service just calls pay without caring which one it is.",
  t_interface: "I would use an interface when I only want to promise the behaviour, and an abstract class when there is some common code I want to share, like a base class with the logging already written.",
  t_topk: "For top ten out of a million I would keep a small heap of size ten and go through the records once, so it's n log k instead of sorting everything, which would be n log n.",
  t_cycle: "To find if a linked list has a cycle I would use the slow and fast pointer, if fast catches up with slow there is a cycle, and it is linear time with constant space.",
  t_complexity: "My solution goes through the string once, so it is linear in the length of the input, and the map holds at most the distinct characters, so the extra space is small.",
  t_generic: "I think the main thing is I try to understand the problem first, then I break it into smaller parts and test each part, that is what I did in my college projects as well.",
  t_dontknow: "Honestly for that one I am not fully sure, I have read about it but I have not used it in a real project.",
  t_question: "What does the team actually work on day to day?",
  t_scale: "If ten times more students used it, the first thing to break would be the search on listings, because it scans the whole table. I would add an index on the title and maybe a cache for the popular searches.",
  h_intro: "I'm Ravi, final year computer science at a college in Hyderabad. Outside of classes I built a campus events app with three friends, I handled the backend and the notifications, and about six hundred students used it during our fest.",
  h_team: "There was a time our team disagreed about the design, two of them wanted to use Firebase and I wanted our own backend. I made a small demo of both over a weekend and showed the cost, and we went with the backend but used Firebase only for push notifications.",
  h_own: "The thing I owned was the notification system. Nobody asked me to, but I noticed people were missing events so I built a reminder that sends a message an hour before. It took me two weeks and after that the attendance for small events went up a lot.",
  h_learn: "When I had to learn Docker for the deployment I had about four days. I skipped the theory, followed one official tutorial, broke the setup twice and fixed it, and by the deadline the app was running in a container.",
  h_motiv: "I want this role because I like building things people actually use, and the team here works on internal tools that real staff use every day. In the first year I want to get good at writing code that other people review.",
  h_weak: "Honestly my weakness is that I over-engineer things. In the events app I built an admin panel nobody used. Now before I build something I ask who will use it and write it down first.",
  h_pressure: "Before our fest the payment page broke the night before. I stayed calm, rolled back to the previous version so people could at least register, and fixed the bug the next morning.",
  h_logistics: "Yes, I am open to relocating anywhere in India, and on the package I would expect the standard fresher range, I am flexible.",
  h_generic: "I think the main thing is I try to understand the problem first and then break it into smaller steps, that is what I did in my college projects too.",
  h_question: "What does the team actually work on day to day?",
  h_contradict: "Actually in that project I was just a team member, someone else led it, I mostly worked on the frontend pages.",
};
const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
for (const [key, text] of Object.entries(BANK)) {
  const a = await tts.generate(text, { voice: "am_adam" });
  writeFileSync(`${OUT}/${key}.wav`, wav(resample(a.audio, a.sampling_rate, RATE), RATE));
  console.log(key, Math.round(a.audio.length / a.sampling_rate), "s");
}
console.log("DONE");
