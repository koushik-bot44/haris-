import { NextResponse } from "next/server";
import { deepgramLiveEnabled, mintDeepgramToken } from "@/lib/stt-server";

// Short-lived Deepgram token for the browser's live transcription socket. The
// API key never leaves the server; the JWT is valid for one minute — long
// enough to open the socket, which then stays up on its own. Rate-limited by
// the middleware under the `stt` rule.

export async function POST() {
  if (!deepgramLiveEnabled()) {
    return NextResponse.json({ error: "deepgram_live_disabled" }, { status: 404 });
  }
  try {
    const { token, expiresIn } = await mintDeepgramToken(60);
    return NextResponse.json({ token, expiresIn }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.warn("[stt] deepgram token grant failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "token_failed" }, { status: 502 });
  }
}
