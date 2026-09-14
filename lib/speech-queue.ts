"use client";

// Ordered sentence queue for voice pipelining. The interview machine pushes
// sentences as the LLM closes them; the queue speaks them back to back under
// ONE SpeakHandle, so cancel() (barge-in, leaving the room) kills everything
// at once.
//
// THE TWO-DRAW RULE — the reason this file exists in its current shape.
//
// The obvious design speaks each sentence as it closes: one synthesis request
// per sentence. It has the best time-to-first-audio and it is what this queue
// used to do, but it makes the interviewer change voice mid-answer, for two
// independent reasons:
//
//   1. Every request can fail on its own. A single 429 or dropped connection
//      re-voices exactly THAT sentence through the fallback engine while its
//      neighbours keep the real one. One reply, three voices.
//   2. Neural TTS is sampled, not rendered. Orpheus and Chatterbox both draw
//      prosody per request, so even when every request succeeds, N independent
//      draws of the same speaker differ in energy, pace and warmth, hard-cut
//      together with no breath between them.
//
// So a turn is now at most TWO draws: the opening sentence, live, for the fast
// start; then the entire remainder as ONE utterance, prepared while the opening
// plays so the hand-off is still gapless. Draw 2 waits (bounded) for the turn
// to close rather than speaking each sentence as it arrives.

import {
  getVoiceEngine,
  prepareSpeak,
  speak,
  type PreparedSpeech,
  type SpeakHandle,
  type SpeakOptions,
  type VoiceEngine,
} from "@/lib/tts";

export interface SpeechQueue extends SpeakHandle {
  push(text: string): void;
  /** No more sentences are coming — `done` resolves once the last one ends. */
  end(): void;
  /** Number of sentences accepted so far. */
  readonly size: number;
  /** How many synthesis requests this turn actually used (1 or 2 normally).
   * Instrumentation for the latency/consistency report. */
  readonly draws: number;
}

export interface SpeechQueueOptions extends SpeakOptions {
  /** Wait for this (e.g. an ack still playing) before the first sentence. */
  gate?: Promise<unknown> | null;
  /** Fired when a draw's audio ACTUALLY starts, with the text that draw speaks.
   *
   * Captions are driven from this rather than from the LLM token stream. The
   * model finishes writing a turn long before the voice finishes saying it, so
   * captioning the token stream puts the whole reply on screen seconds before
   * it is heard — the reader is done before the interviewer has started, which
   * reads as lag even when the audio is on time. Anchoring the caption to real
   * playback keeps the two together. */
  onSpeaking?: (spokenText: string, drawIndex: number) => void;
}

/** How long draw 2 waits for the turn to close before speaking what it has.
 * The LLM normally finishes a turn well inside this; the bound only exists so
 * a stalled stream cannot leave the interviewer silent. */
const CLOSE_WAIT_MS = 1_500;

/** Backstop for a caller that never closes the turn. Only reached when end()
 * and cancel() were both forgotten — without it `done` would never resolve. */
const MAX_IDLE_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createSpeechQueue(opts: SpeechQueueOptions = {}): SpeechQueue {
  const engine = getVoiceEngine();
  const speakOpts: SpeakOptions = { voice: opts.voice, hue: opts.hue, rate: opts.rate };
  const items: string[] = [];
  let ended = false;
  let cancelled = false;
  let current: SpeakHandle | null = null;
  let pendingPrepared: PreparedSpeech | null = null;
  let consumed = 0;
  let draws = 0;
  let firstResolved = false;

  let resolveFirst!: (t: number) => void;
  const firstSyllableAt = new Promise<number>((r) => (resolveFirst = r));
  let resolveEngine!: (e: VoiceEngine) => void;
  const engineUsed = new Promise<VoiceEngine>((r) => (resolveEngine = r));
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  // Multi-waiter wake-up: push(), end() and cancel() all release everyone
  // currently waiting. A single-slot waiter would strand the close-watcher
  // whenever a push happened to wake the player instead.
  let waiters: (() => void)[] = [];
  const notify = () => {
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  };
  const waitForWork = () => new Promise<void>((r) => waiters.push(r));

  /** Resolve when the turn closes (or is cancelled), or after `ms`. */
  const waitForClose = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ended || cancelled) return resolve();
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, ms);
      const check = () => {
        if (ended || cancelled) return settle();
        if (!settled) waiters.push(check);
      };
      waiters.push(check);
    });

  const settle = () => {
    if (!firstResolved) {
      resolveFirst(Date.now());
      resolveEngine(engine);
    }
    resolveDone();
  };

  /** Speak one utterance and wait it out, tracking it for cancel(). */
  const play = async (handle: SpeakHandle, spokenText: string) => {
    current = handle;
    const index = draws;
    draws++;
    if (!firstResolved) {
      firstResolved = true;
      handle.firstSyllableAt.then(resolveFirst);
      handle.engineUsed.then(resolveEngine);
    }
    // Caption on real playback, not on generation — see onSpeaking above.
    if (opts.onSpeaking) {
      handle.firstSyllableAt.then(() => {
        if (!cancelled) opts.onSpeaking?.(spokenText, index);
      });
    }
    await handle.done;
    current = null;
  };

  void (async () => {
    if (opts.gate) {
      try {
        await opts.gate;
      } catch {}
    }

    // Wait for the first closed sentence.
    while (!cancelled && items.length === 0 && !ended) await waitForWork();
    if (cancelled || items.length === 0) return settle();

    // ——— DRAW 1: the opening sentence, live, for the earliest audio ———
    consumed = 1;
    const first = speak(items[0], speakOpts);

    // ——— DRAW 2: the whole remainder, prepared while draw 1 plays ———
    // Kicked off concurrently so synthesis hides behind playback; it waits for
    // the turn to close first so the remainder is one utterance, not one per
    // sentence.
    const restPrepared = (async (): Promise<{ prepared: PreparedSpeech; text: string } | null> => {
      await waitForClose(CLOSE_WAIT_MS);
      if (cancelled) return null;
      const rest = items.slice(consumed).join(" ").trim();
      consumed = items.length;
      if (!rest) return null;
      const p = prepareSpeak(rest, speakOpts);
      pendingPrepared = p;
      return { prepared: p, text: rest };
    })();
    restPrepared.catch(() => {});

    await play(first, items[0]);
    if (cancelled) {
      (await restPrepared.catch(() => null))?.prepared.cancel();
      return settle();
    }

    const rest = await restPrepared.catch(() => null);
    if (rest) {
      await rest.prepared.ready;
      pendingPrepared = null;
      if (cancelled) {
        rest.prepared.cancel();
        return settle();
      }
      await play(rest.prepared.play(), rest.text);
    }

    // ——— TAIL: stay open until the CALLER closes the turn ———
    //
    // This loop must not settle merely because it has said everything it
    // currently holds. `done` resolving before end() breaks the contract
    // push()/end() advertise: push() would go on accepting sentences (size
    // grows, so the caller believes they are queued) that nothing would ever
    // speak. In the app that happens whenever the model stalls for longer than
    // CLOSE_WAIT_MS behind a short opening sentence — the reply is truncated to
    // that one sentence while the caption and the stored transcript show the
    // whole paragraph, and nothing anywhere reports the loss.
    //
    // A very slow model can also close the turn after draw 2 was formed; that
    // tail is spoken as ONE more utterance rather than reverting to
    // per-sentence draws.
    let idleSince = Date.now();
    for (;;) {
      if (cancelled) break;
      if (consumed < items.length) {
        const tail = items.slice(consumed).join(" ").trim();
        consumed = items.length;
        if (tail) {
          await play(speak(tail, speakOpts), tail);
          idleSince = Date.now();
        }
        continue;
      }
      if (ended) break;
      // Nothing to say and the turn is still open: wait for a push, for end(),
      // or for the poll interval — whichever comes first.
      await Promise.race([waitForWork(), sleep(CLOSE_WAIT_MS)]);
      if (cancelled || ended || consumed < items.length) continue;
      // Backstop only. A caller that never calls end() or cancel() would
      // otherwise leave `done` pending forever and hang the turn.
      if (Date.now() - idleSince > MAX_IDLE_MS) {
        console.warn("[tts] speech queue closed itself — end() was never called");
        break;
      }
    }
    settle();
  })();

  return {
    push(text: string) {
      const t = text.trim();
      if (!t || ended || cancelled) return;
      items.push(t);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      ended = true;
      current?.cancel();
      pendingPrepared?.cancel();
      notify();
    },
    get size() {
      return items.length;
    },
    get draws() {
      return draws;
    },
    done,
    firstSyllableAt,
    engineUsed,
  };
}
