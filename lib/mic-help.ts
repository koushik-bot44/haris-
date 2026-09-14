// Human copy for every microphone / speech-engine degrade code — shared by
// the interview room and the GD room so both explain the same problem the
// same way (and neither shows a raw code like "whisper_loading").

export function micHelp(reason: string | null, opts: { cloudStt?: boolean } = {}): string {
  switch (reason) {
    case "unsupported":
      return opts.cloudStt
        ? "This browser has no built-in speech recognition — switching to the server's transcription, which works in any browser. Hit “Try microphone again”."
        : "This browser has no built-in speech recognition — switching to the on-device engine (a one-time ~40MB download). Voice will work here once it's ready.";
    case "not-allowed":
    case "service-not-allowed":
      return "The microphone is blocked. Click the lock (or camera) icon in the address bar → Microphone → Allow, then try again.";
    case "audio-capture":
      return "No microphone was found. Plug one in (or pick the right input in your system sound settings) and try again.";
    case "network":
      return opts.cloudStt
        ? "Your browser can't reach Google's speech service (Brave, Arc, plain Chromium builds and some VPNs block it — your internet is fine). Switching to the server's transcription — hit “Try microphone again”."
        : "Your browser can't reach Google's speech service — Brave, Arc, plain Chromium builds, and some VPNs all block it (your internet is fine). Two fixes: open this page in real Google Chrome, or wait for the on-device speech engine below — a one-time ~40MB download that works in ANY browser, even offline.";
    case "whisper_loading":
      return "The on-device speech engine is still downloading (~40MB, one time). Try the microphone again when it says ready — or continue in text mode meanwhile.";
    case "whisper_failed":
      return "The on-device speech engine failed to load on this machine. Text mode works everywhere; real Google Chrome enables the online engine.";
    case "cloud_rate_limited":
      return "The cloud transcription service is busy right now (its free tier allows only a few requests a minute). Voice continues on the next engine — or type your answer below.";
    case "cloud_transcribe":
    case "transcribe_failed":
      return "The transcription service didn't respond. Check your connection and try the microphone again.";
    case "too_many_restarts":
      return "The speech recognizer kept dropping out. Try the microphone again — if it keeps happening, text mode is a reliable fallback.";
    default:
      return "Microphone unavailable right now. You can retry, or continue in text mode — questions are still spoken aloud and always captioned.";
  }
}
