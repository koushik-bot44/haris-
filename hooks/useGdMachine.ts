"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GdHistoryEntry, GdMetrics, GdPersona, GdRequest, GdTurn, Session, Turn } from "@/lib/types";
import { computeGdTurns, GD_WRAP_AFTER, gdWrapup, isGdWrapTurn } from "@/lib/gd/flow";
import { GD_PERSONAS, gdPersona } from "@/lib/gd/personas";
import {
  airtimeFromTurns,
  candidateFinals,
  candidateTurnStart,
  composeGdVerdict,
  markInterrupt,
  speechRateCharsPerMs,
  spokenPrefix,
  type FloorAdoption,
  type InterruptMark,
} from "@/lib/gd/airtime";
import {
  getSttEngine,
  resolveSttCapabilities,
  setSttEngineEphemeral,
  startStt,
  sttCapabilities,
  type SttSession,
} from "@/lib/stt";
import { ensureWhisperLoading } from "@/lib/stt-whisper";
import { fullTranscript, type SttState } from "@/lib/stt-reducer";
import {
  prepareSpeak,
  resolveVoiceEngine,
  speak,
  unlockAudio,
  type PreparedSpeech,
  type SpeakHandle,
} from "@/lib/tts";
import { decideBargeIn, echoOverlap, ECHO_OVERLAP_THRESHOLD } from "@/lib/barge-in";
import { newSessionId, saveSession } from "@/lib/session-store";
import { playAck, prepareAcks, resetAcks, type AckHandle } from "@/lib/ack";
import { setVizMode, startMicViz, stopMicViz } from "@/lib/audio-viz";

// The GD room state machine — a fork of useInterviewMachine's battle-tested
// patterns for a 4-voice debate the student fights their way into:
//   micCheck → preroll → discussion (persona turns ⇄ candidate floor) → wrapup → done
// The mic is LIVE through every persona turn: sustained non-echo speech cancels
// the speaker (barge-in) and takes the floor; hold-SPACE is the explicit grab.
// Turn-taking on the floor matches the 1:1 room: 1.5s of silence or Enter ends
// the candidate's turn, then the personas react to what was actually said.
//
// TWO INVARIANTS EVERYTHING BELOW SERVES.
//
// 1. ONE MICROPHONE, ONE RECOGNIZER. The mic is live through every persona
//    turn, so the room is always one `await` away from having two
//    SpeechRecognition sessions open — the live interrupt listener and the
//    candidate's floor. Two recognizers on one device drop each other's words,
//    which the student experiences as "it didn't hear me". Every suspension
//    point here therefore re-checks the FLOOR, not just whether the room is
//    still open, and a persona turn that finds the floor taken refuses to speak
//    at all (outcome "deferred") rather than talking over them.
//
// 2. THE RECORDING IS WHAT THE ROOM ACTUALLY HEARD. A persona cancelled
//    mid-word is recorded as the words that were audible, never its full line
//    (lib/gd/airtime.ts: spokenPrefix) — otherwise the next batch reacts to
//    sentences nobody heard and the airtime split counts words nobody said.
//    A candidate turn starts at THEIR first word, not at the persona's echo in
//    the same trace (candidateTurnStart).

export type GdPhase = "micCheck" | "preroll" | "discussion" | "wrapup" | "done";

/** How a persona turn ended:
 * - completed   — spoke its whole line, floor still free
 * - interjected — the candidate took the floor over/right after it
 * - deferred    — the candidate ALREADY had the floor, so it never spoke
 * - ended       — the room closed underneath it */
export type GdTurnOutcome = "completed" | "interjected" | "deferred" | "ended";

export const GD_SILENCE_MS = 1500;
export const GD_CAP_MS = 270_000; // ~4.5 minutes, then the moderator wraps
export const GD_BATCH_TURNS = 3;
/** A silent floor-grab must not stall the room forever. */
export const GD_EMPTY_FLOOR_MS = 5000;
const INTER_TURN_PAUSE_MS = 450;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export interface GdMachine {
  phase: GdPhase;
  /** Persona id, "candidate", or null (between turns / fetching). */
  activeSpeaker: string | null;
  caption: { speaker: string; text: string } | null;
  thinking: boolean;
  hearing: boolean;
  lastSentence: string;
  micCheckTranscript: string;
  /** Warning-card text: the STT degrade reason (a code — see lib/mic-help). */
  micBlocked: string | null;
  /** Debate-engine notice (rate limit / fallback) — separate from mic trouble. */
  engineNotice: string | null;
  transcript: Turn[];
  /** Live metrics, recomputed after every recorded turn. */
  metrics: GdMetrics | null;
  candidateHasFloor: boolean;
  discussionStartedAt: number | null;
  session: Session | null;
  sessionPersisted: boolean;
  personas: GdPersona[];
  beginMicCheck: () => void;
  confirmMicCheck: () => void;
  startDiscussion: () => void;
  takeFloor: () => void;
  endFloorNow: () => void;
  cleanup: () => void;
}

export function useGdMachine(candidateName: string, topic: string): GdMachine {
  const [phase, setPhase] = useState<GdPhase>("micCheck");
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [caption, setCaption] = useState<{ speaker: string; text: string } | null>(null);
  const [thinking, setThinking] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [lastSentence, setLastSentence] = useState("");
  const [micCheckTranscript, setMicCheckTranscript] = useState("");
  const [micBlocked, setMicBlocked] = useState<string | null>(null);
  const [engineNotice, setEngineNotice] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [metrics, setMetrics] = useState<GdMetrics | null>(null);
  const [candidateHasFloor, setCandidateHasFloor] = useState(false);
  const [discussionStartedAt, setDiscussionStartedAt] = useState<number | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionPersisted, setSessionPersisted] = useState(true);

  const endedRef = useRef(false);
  const startedRef = useRef(false);
  const phaseRef = useRef<GdPhase>("micCheck");
  const historyRef = useRef<GdHistoryEntry[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  const discussionStartTRef = useRef<number | null>(null);
  const personaTurnCountRef = useRef(0);
  const micCheckSttRef = useRef<SttSession | null>(null);
  const interruptSttRef = useRef<SttSession | null>(null);
  const sttFloorRef = useRef<SttSession | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speakRef = useRef<SpeakHandle | null>(null);
  const ackRef = useRef<AckHandle | null>(null);
  const ttsTurnStartRef = useRef<number | null>(null);
  /** The persona turn currently on the speakers. `audioEnded` flips the moment
   * its audio finishes (before the turn's own bookkeeping runs), so a floor
   * grab can tell "cut the voice off" from "took the floor in the gap". */
  const turnCtxRef = useRef<{
    handle: SpeakHandle;
    mark: InterruptMark;
    audioEnded: { v: boolean };
    text: string;
  } | null>(null);
  /** Ahead-of-time synthesis for the NEXT persona line, keyed by its text. The
   * whole three-turn batch is known in advance, so the hand-off between
   * debaters need not contain a synthesis wait. */
  const preparedRef = useRef<{ text: string; prep: PreparedSpeech } | null>(null);
  /** Chars spoken / ms of audio across persona turns that ran to completion —
   * the room's OWN measured speaking rate. It is what turns "cancelled 3.2s in"
   * into the words that were actually heard (see spokenPrefix). */
  const speechRateRef = useRef({ chars: 0, ms: 0 });
  const floorActiveRef = useRef(false);
  /** endFloor is mid-settle (STT finalizing): the floor is not free yet. A
   * grab in this window used to reuse the dying deferred and spin the loop. */
  const floorSettlingRef = useRef(false);
  const floorStartTRef = useRef(0);
  const floorDoneRef = useRef<Deferred | null>(null);
  /** Snapshot at adoption of a barge-in session: what the mic heard BEFORE
   * the candidate took the floor is the persona through the speakers. */
  const floorAdoptRef = useRef<FloorAdoption | null>(null);
  /** Bumped on every recorded candidate turn — in-flight batches stamped with
   * an older version were computed without that point and must be discarded. */
  const historyVersionRef = useRef(0);
  /** STT degraded during the discussion — the verdict must not read a dead mic
   * as a silent candidate. */
  const micTroubleRef = useRef(false);
  /** The 429 message currently shown, so a recovered fetch can clear it. */
  const rateLimit429Ref = useRef<string | null>(null);
  // Fresh-closure helpers assigned every render (bottom of hook) so memoized
  // callbacks never capture a stale endFloor — the confirmed bug class the
  // 1:1 machine's adversarial review found.
  const watchFloorSilenceRef = useRef<(sess: SttSession) => void>(() => {});
  const adoptFloorRef = useRef<(sess: SttSession | null, echoRef: string | null) => void>(() => {});
  const endFloorRef = useRef<() => Promise<void>>(async () => {});

  const toPhase = (p: GdPhase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  /** The candidate owns the room right now — actively speaking, or still
   * settling the transcript of what they just said. NOTHING may open a second
   * recognizer or a persona voice against that. */
  const floorBusy = useCallback(() => floorActiveRef.current || floorSettlingRef.current, []);

  /** Throw away a pre-rendered line: the batch it belonged to is stale (the
   * candidate spoke) or the room is closing. Also aborts the in-flight fetch,
   * so a discarded speculation costs the voice server nothing further. */
  const dropPrepared = useCallback(() => {
    preparedRef.current?.prep.cancel();
    preparedRef.current = null;
  }, []);

  /** Claim the pre-rendered audio for `text`, if that is what was warmed.
   * Anything else warmed is stale by definition and is cancelled here. */
  const takePrepared = useCallback((text: string): PreparedSpeech | null => {
    const p = preparedRef.current;
    preparedRef.current = null;
    if (!p) return null;
    if (p.text === text) return p.prep;
    p.prep.cancel();
    return null;
  }, []);

  /** Render `turn` ahead of time while something else is speaking. ONE
   * preparation per turn — this is the two-draw rule seen from the GD side, not
   * a new per-sentence synthesis path. */
  const warmNext = useCallback((turn: GdTurn | undefined) => {
    if (!turn || endedRef.current) return;
    if (preparedRef.current?.text === turn.text) return;
    preparedRef.current?.prep.cancel();
    const persona = gdPersona(turn.personaId);
    preparedRef.current = {
      text: turn.text,
      prep: prepareSpeak(turn.text, { voice: persona?.voice, hue: persona?.hue }),
    };
  }, []);

  const cleanup = useCallback(() => {
    endedRef.current = true;
    clearSilenceTimer();
    try {
      micCheckSttRef.current?.stop();
      interruptSttRef.current?.stop();
      sttFloorRef.current?.stop();
    } catch {}
    speakRef.current?.cancel();
    ackRef.current?.cancel();
    dropPrepared();
    stopMicViz();
    setVizMode("idle");
  }, [dropPrepared]);

  // StrictMode runs mount → cleanup → mount in dev. The refs survive that
  // simulated remount, so the flags MUST be re-armed in the effect setup or
  // the machine is permanently dead before the user clicks anything.
  useEffect(() => {
    endedRef.current = false;
    startedRef.current = false;
    micTroubleRef.current = false;
    return cleanup;
  }, [cleanup]);

  // ——— mic check (GD is voice-only — no text mode to degrade into) ———

  /** Same engine failover as the 1:1 room: a browser that cannot reach
   * Google's recognizer flips to the server's transcription (any browser),
   * else to on-device Whisper, for this visit only. */
  const failoverStt = (reason: string) => {
    if (reason !== "network" && reason !== "unsupported") return;
    const current = getSttEngine();
    if (sttCapabilities()?.cloud && current !== "cloud" && current !== "deepgram") {
      setSttEngineEphemeral("cloud");
    } else if (current !== "whisper" && current !== "cloud") {
      setSttEngineEphemeral("whisper");
      ensureWhisperLoading();
    }
  };

  const beginMicCheck = useCallback(() => {
    if (micCheckSttRef.current) return;
    unlockAudio(); // the click is the user gesture that unlocks audio output
    void resolveSttCapabilities();
    setMicBlocked(null);
    const sess = startStt({
      onUpdate: (s: SttState) => {
        setMicCheckTranscript(fullTranscript(s));
        setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
      },
      onDegrade: (reason) => {
        micCheckSttRef.current = null;
        failoverStt(reason);
        setMicBlocked(reason);
      },
    });
    micCheckSttRef.current = sess;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmMicCheck = useCallback(() => {
    try {
      micCheckSttRef.current?.stop();
    } catch {}
    micCheckSttRef.current = null;
    unlockAudio();
    // Permission is granted by now — open the orb's true-amplitude mic tap,
    // settle on the best voice engine, then pre-generate moderator-voice acks
    // (the latency mask after interjections).
    void startMicViz();
    resetAcks();
    void resolveVoiceEngine().then(() => {
      if (endedRef.current) return;
      void prepareAcks(gdPersona("moderator")?.voice);
      // The moderator's opening is deterministic — render it NOW, while the
      // preroll card is being read, so "Start the discussion" is answered by a
      // voice instead of by a synthesis wait.
      warmNext(computeGdTurns(topic, candidateName, [], 1)[0]);
    });
    toPhase("preroll");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateName, topic, warmNext]);

  // ——— shared recording ———

  const pushTurn = useCallback((t: Turn) => {
    turnsRef.current.push(t);
    setTranscript([...turnsRef.current]);
    if (discussionStartTRef.current !== null) {
      setMetrics(airtimeFromTurns(turnsRef.current, discussionStartTRef.current));
    }
  }, []);

  // ——— candidate floor ———

  const startFloorStt = useCallback((): SttSession | null => {
    return startStt({
      onUpdate: (s: SttState) => {
        const lastFinal = s.finalSegments[s.finalSegments.length - 1] ?? "";
        setLastSentence(lastFinal);
        setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
      },
      onDegrade: (reason) => {
        // Voice is the room's only input — end the floor with what we have and
        // surface the reason; the debate itself keeps going.
        micTroubleRef.current = true;
        failoverStt(reason);
        setMicBlocked(reason);
        void endFloorRef.current();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Explicit floor-grab (SPACE / button). Mid-persona-turn it cancels the
   * speaker and adopts the already-live interrupt mic; in a gap it opens a
   * fresh session — the batch loop waits for the floor before continuing.
   * Refused while the previous floor is still settling its transcript. */
  const takeFloor = useCallback(() => {
    if (endedRef.current || floorActiveRef.current || floorSettlingRef.current) return;
    if (phaseRef.current !== "discussion" && phaseRef.current !== "wrapup") return;
    const ctx = turnCtxRef.current;
    if (ctx) {
      if (ctx.mark.promoted) return;
      // Cut the recorded line only if the voice was still audible: a press
      // landing after the last syllable takes the floor without an em dash.
      markInterrupt(ctx.mark, ctx.audioEnded.v);
      const sess = interruptSttRef.current;
      interruptSttRef.current = null;
      ctx.handle.cancel();
      adoptFloorRef.current(sess ?? startFloorStt(), ctx.text);
    } else {
      adoptFloorRef.current(startFloorStt(), null);
    }
  }, [startFloorStt]);

  const endFloorNow = useCallback(() => {
    if (floorActiveRef.current) void endFloorRef.current();
  }, []);

  /** Wait for the current floor (or its settle) to finish. Always yields at
   * least a macrotask, so a loop that spins on this can never starve the
   * timers and key handlers that end the floor. */
  const waitFloor = useCallback(async () => {
    const d = floorDoneRef.current;
    if (d) await d.promise;
    else await new Promise((r) => setTimeout(r, 50));
  }, []);

  // ——— persona speech ———

  /** Speak one persona turn with the mic LIVE against it.
   *
   * Resolves "interjected" when the candidate took the floor (barge-in, SPACE,
   * or early start), and "deferred" when the floor was ALREADY the candidate's
   * at a suspension point, so this turn never opened its mouth.
   *
   * That second outcome is the fix for the room's worst bug. Every `await` here
   * is a window in which the candidate can grab the floor — the ack wait was
   * the long one — and the old code re-checked only `endedRef` afterwards. It
   * would then start a persona voice ON TOP of the speaking candidate and open
   * a SECOND SpeechRecognition session while the floor session was live: two
   * recognizers fighting over one microphone, which is heard as words being
   * dropped. So: after every suspension point, re-check the floor, not just the
   * room. `next`, when given, is the following turn in the batch — rendered
   * ahead of time while this one plays. */
  const playPersonaTurn = useCallback(
    async (turn: GdTurn, next?: GdTurn): Promise<GdTurnOutcome> => {
      if (endedRef.current) return "ended";
      if (floorBusy()) return "deferred";
      const persona = gdPersona(turn.personaId);
      const name = persona?.name ?? turn.personaId;
      setThinking(false);
      setCaption({ speaker: name, text: turn.text });
      setActiveSpeaker(turn.personaId);

      // Let a pending ack finish before the persona starts (overlap garbles).
      // Capture the handle: endFloor can assign a NEW ack while this await is
      // parked (candidate spoke, floor settled, "mm-hm" queued), and nulling
      // the ref unconditionally afterwards orphaned that ack — still playing,
      // no longer cancellable, and free to overlap the persona line. Only
      // clear the ref if it is still the ack that was waited on.
      const pendingAck = ackRef.current;
      if (pendingAck) {
        await pendingAck.done;
        if (ackRef.current === pendingAck) ackRef.current = null;
        if (endedRef.current) return "ended";
        // SUSPENSION POINT — the candidate may own the room now.
        if (floorBusy()) {
          setCaption(null);
          setActiveSpeaker(null);
          return "deferred";
        }
      }

      // Pre-rendered by the previous turn (or by the preroll, for the opening),
      // so this starts speaking with no synthesis latency at all. play() falls
      // back to a live speak() by itself when preparation failed.
      const prepared = takePrepared(turn.text);
      const handle = prepared ? prepared.play() : speak(turn.text, { voice: persona?.voice, hue: persona?.hue });
      speakRef.current = handle;
      ttsTurnStartRef.current = null;
      handle.firstSyllableAt.then((t) => {
        ttsTurnStartRef.current = t;
      });
      // Render the NEXT debater behind this one's audio. Cancelled the moment
      // the candidate takes the floor (adoptFloor), because the batch it came
      // from is stale at that point.
      warmNext(next);

      // Live mic for the whole turn: sustained non-echo speech = barge-in.
      // The CURRENT persona's text is the echo reference (pinned contract).
      const mark: InterruptMark = { promoted: false, cutOff: false };
      // Registered BEFORE anything can cancel: this `.then` runs ahead of the
      // `await handle.done` continuation below, so by the time any floor grab
      // can observe it, "the audio has ended" is already true for a line that
      // ran to its last syllable — and a grab in that window is not a cut.
      const audioEnded = { v: false };
      const flagEnded = () => {
        audioEnded.v = true;
      };
      void handle.done.then(flagEnded, flagEnded);
      turnCtxRef.current = { handle, mark, audioEnded, text: turn.text };
      // `dead` is set the moment the session is discarded: every recognizer
      // delivers a final result AFTER stop(), and that late result must not
      // adopt a dead mic as the floor.
      const holder: { sess: SttSession | null; dead: boolean } = { sess: null, dead: false };
      holder.sess = startStt({
        onUpdate: (s: SttState) => {
          if (holder.dead) return;
          setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
          if (mark.promoted) {
            const lastFinal = s.finalSegments[s.finalSegments.length - 1] ?? "";
            setLastSentence(lastFinal);
            return;
          }
          const heard = fullTranscript(s);
          const msSince = ttsTurnStartRef.current === null ? 0 : Date.now() - ttsTurnStartRef.current;
          if (
            holder.sess &&
            !endedRef.current &&
            decideBargeIn({ heardText: heard, spokenText: turn.text, msSinceTtsStart: msSince }) === "interrupt"
          ) {
            // A recognizer can deliver this result AFTER the audio ended (they
            // all flush late) — then it is an early start, not a cut.
            markInterrupt(mark, audioEnded.v);
            interruptSttRef.current = null;
            handle.cancel();
            adoptFloorRef.current(holder.sess, turn.text);
          }
        },
        onDegrade: (reason) => {
          if (holder.dead) return;
          micTroubleRef.current = true;
          // Pre-promotion listener death is not fatal (1:1 rule) — the next
          // floor attempt starts fresh and reports properly if it persists.
          if (!mark.promoted) {
            interruptSttRef.current = null;
            failoverStt(reason);
            setMicBlocked(reason);
          }
        },
      });
      interruptSttRef.current = holder.sess;

      await handle.done;
      turnCtxRef.current = null;
      const tEnd = Date.now();
      // Airtime honesty: synthesis latency is not speaking time. Every engine
      // settles firstSyllableAt before done resolves, so this never hangs.
      const tStart = await handle.firstSyllableAt.catch(() => Date.now());
      if (endedRef.current) return "ended";
      const audibleMs = Math.max(0, tEnd - tStart);

      // Read BEFORE the early-start branch below can promote: `cutOff` is set
      // only by an interruption that landed while the audio was still playing
      // (markInterrupt), which is the only case where the recorded line must
      // be cut short. `promoted` alone is NOT that — a SPACE press can land
      // after the last syllable and still take this floor.
      const cutOff = mark.cutOff;
      let said = turn.text;
      if (cutOff) {
        // Recording the FULL line here was a quiet corruption of the whole
        // round: the debate engine received sentences nobody ever heard and
        // reacted to them, and the airtime split counted words that were never
        // spoken. Record what the speakers actually produced.
        said = spokenPrefix(
          turn.text,
          audibleMs,
          speechRateCharsPerMs(speechRateRef.current.chars, speechRateRef.current.ms),
        );
      } else {
        // An uninterrupted turn is a rate sample — the room learns how fast its
        // own voice actually is, so the next cut lands in the right place.
        speechRateRef.current.chars += turn.text.length;
        speechRateRef.current.ms += audibleMs;
      }

      // Cut off before one whole word landed: nobody heard this persona, so it
      // never happened — no transcript line, no history, no wrap-clock tick.
      if (said) {
        // tEnd marks where the voice stopped, which is exactly what the
        // interjection-overlap metric needs.
        pushTurn({ speaker: "interviewer", text: said, tStart, tEnd, personaId: turn.personaId, personaName: name });
        historyRef.current.push({ personaId: turn.personaId, text: said });
        personaTurnCountRef.current++;
      }

      if (mark.promoted) return "interjected";

      const isess = interruptSttRef.current;
      interruptSttRef.current = null;
      // SUSPENSION POINT (handle.done / firstSyllableAt): with turnCtx already
      // cleared, a SPACE press in this window opens a fresh floor session of its
      // own. That floor is the live mic now, so this turn's listener has to die
      // instead of lingering as a second recognizer on the same microphone.
      if (isess && floorBusy()) {
        holder.dead = true;
        try {
          isess.stop();
        } catch {}
        return "interjected";
      }
      if (isess) {
        const heard = fullTranscript(isess.getState()).trim();
        // Early start: the candidate began during the tail of the turn. A
        // stray non-echo syllable is noise, not an interjection — require a
        // little substance before it becomes a recorded floor.
        const substantial = heard.length >= 8 && heard.split(/\s+/).length >= 2;
        if (substantial && echoOverlap(heard, turn.text) < ECHO_OVERLAP_THRESHOLD) {
          markInterrupt(mark, true); // the line finished — an early start, never a cut
          adoptFloorRef.current(isess, turn.text);
          return "interjected";
        }
        holder.dead = true;
        try {
          isess.stop(); // echo or noise — discard
        } catch {}
      }
      setActiveSpeaker(null);
      return "completed";
    },
    [floorBusy, pushTurn, takePrepared, warmNext],
  );

  /** Play a persona turn, waiting out a floor the candidate is holding first.
   * playPersonaTurn REFUSES to speak over the candidate ("deferred"); this is
   * the caller-side retry once the floor is genuinely free. Bounded, so a
   * candidate hammering SPACE can slow the room down but never spin this loop. */
  const playWhenFree = useCallback(
    async (turn: GdTurn, next?: GdTurn): Promise<GdTurnOutcome> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        while (floorBusy()) {
          await waitFloor();
          if (endedRef.current) return "ended";
        }
        const r = await playPersonaTurn(turn, next);
        if (r !== "deferred") return r;
      }
      return "deferred";
    },
    [floorBusy, playPersonaTurn, waitFloor],
  );

  // ——— discussion loop ———

  const fetchBatch = useCallback(async (): Promise<GdTurn[]> => {
    const body: GdRequest = {
      topic,
      candidateName,
      history: historyRef.current,
      wantTurns: GD_BATCH_TURNS,
    };
    try {
      const res = await fetch("/api/gd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        // Rate-limited: show the server's own message on its OWN notice —
        // the scripted rescue below keeps the room alive, but never silently.
        const err = (await res.json().catch(() => null)) as { message?: string } | null;
        const msg = err?.message ?? "The debate engine is rate-limited — continuing with scripted turns.";
        rateLimit429Ref.current = msg;
        setEngineNotice(msg);
        throw new Error("api_429");
      }
      if (!res.ok) throw new Error(`api_${res.status}`);
      const data = (await res.json()) as { turns?: GdTurn[]; provider?: string };
      if (!Array.isArray(data.turns)) throw new Error("bad_shape");
      if (rateLimit429Ref.current !== null) {
        // Recovered — clear the 429 notice.
        rateLimit429Ref.current = null;
        setEngineNotice(null);
      }
      return data.turns;
    } catch (err) {
      // The room never dies: the scripted engine is isomorphic — run it here.
      if (!(err instanceof Error && err.message === "api_429")) {
        setEngineNotice("The debate engine didn't respond — continuing with scripted turns.");
      }
      return computeGdTurns(topic, candidateName, historyRef.current, GD_BATCH_TURNS);
    }
  }, [candidateName, topic]);

  const finishDiscussion = useCallback(() => {
    cleanup();
    const startedAt = discussionStartTRef.current ?? Date.now();
    const gdMetrics = airtimeFromTurns(turnsRef.current, startedAt);
    const s: Session = {
      _id: newSessionId(),
      userId: null,
      role: "general",
      roundType: "gd",
      codingUsed: false,
      startedAt,
      turns: turnsRef.current,
      perQuestionScores: [],
      deliveryMetrics: null,
      metricsVersion: 1,
      latency: { perTurnMs: [], avgMs: null },
      overall: composeGdVerdict(gdMetrics, { micTrouble: micTroubleRef.current }),
      gdMetrics,
      topic,
    };
    const { persisted } = saveSession(s);
    setSessionPersisted(persisted);
    setMetrics(gdMetrics);
    setSession(s);
    toPhase("done");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanup, topic]);

  const doWrap = useCallback(async () => {
    toPhase("wrapup");
    // Never wrap OVER the candidate — playWhenFree waits out an active (or
    // settling) floor before the moderator opens her mouth.
    const r = await playWhenFree({ personaId: "moderator", text: gdWrapup(topic, candidateName) });
    if (r === "ended") return;
    if (r === "interjected" || r === "deferred") {
      // Let them land the last word, then close anyway.
      await waitFloor();
      if (endedRef.current) return;
    }
    finishDiscussion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateName, finishDiscussion, playWhenFree, topic, waitFloor]);

  const runDiscussion = useCallback(async () => {
    const startT = Date.now();
    discussionStartTRef.current = startT;
    setDiscussionStartedAt(startT);
    const overTime = () => Date.now() - startT >= GD_CAP_MS;

    // Deterministic opening — instant, no network, kills session-start dead air
    // (and pre-rendered during the preroll, so not even synthesis latency).
    for (const t of computeGdTurns(topic, candidateName, [], 1)) {
      const r = await playWhenFree(t);
      if (r === "ended") return;
      if (r === "interjected" || r === "deferred") {
        await waitFloor();
        if (endedRef.current) return;
      }
    }

    while (!endedRef.current) {
      if (overTime() || personaTurnCountRef.current >= GD_WRAP_AFTER) {
        await doWrap();
        return;
      }
      setThinking(true);
      setActiveSpeaker(null);
      setCaption(null); // the last line is over — "the room takes a breath"
      const batchVersion = historyVersionRef.current; // what this fetch knows
      const batch = await fetchBatch();
      setThinking(false);
      if (endedRef.current) return;
      // The candidate grabbed the floor during the fetch (or is still settling
      // it) — this batch is stale (it doesn't react to what they're saying).
      // Wait, then fetch fresh.
      if (floorBusy()) {
        await waitFloor();
        if (endedRef.current) return;
        continue;
      }
      // Grab-AND-release while the fetch was in flight: the resolved batch was
      // computed WITHOUT their point — discard it and refetch fresh.
      if (historyVersionRef.current !== batchVersion) continue;
      if (batch.length === 0) {
        await doWrap();
        return;
      }
      for (let i = 0; i < batch.length; i++) {
        const t = batch[i];
        if (endedRef.current) return;
        if (overTime()) break;
        // Floor grabbed between persona turns: never speak over the candidate.
        while (floorBusy()) {
          await waitFloor();
          if (endedRef.current) return;
        }
        // If they said anything, the rest of this batch is stale — refetch.
        if (historyVersionRef.current !== batchVersion) break;
        // batch[i + 1] is rendered ahead of time behind this turn's audio: the
        // whole batch is known here, so a debater hand-off need never be a
        // synthesis wait. undefined on the last turn — nothing to warm.
        const r = await playWhenFree(t, batch[i + 1]);
        if (r === "ended") return;
        if (r === "deferred") {
          // The floor stayed the candidate's across every retry — this batch is
          // stale by definition; wait them out and react to what they said.
          await waitFloor();
          if (endedRef.current) return;
          break;
        }
        if (r === "interjected") {
          await waitFloor();
          if (endedRef.current) return;
        }
        if (isGdWrapTurn(t)) {
          // The engine already closed the round — don't wrap twice.
          finishDiscussion();
          return;
        }
        if (r === "interjected") break; // personas must react — fresh batch
        await new Promise((res) => setTimeout(res, INTER_TURN_PAUSE_MS));
        if (endedRef.current) return;
      }
    }
  }, [candidateName, doWrap, fetchBatch, finishDiscussion, floorBusy, playWhenFree, topic, waitFloor]);

  const startDiscussion = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    toPhase("discussion");
    void runDiscussion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runDiscussion]);

  // Voice-orb mode follows the room state; levels are fed by the audio paths.
  useEffect(() => {
    if (phase === "discussion" || phase === "wrapup") {
      if (activeSpeaker === "candidate") setVizMode("user");
      else if (activeSpeaker) setVizMode("ai");
      else setVizMode("thinking");
    } else {
      setVizMode("idle");
    }
  }, [phase, activeSpeaker]);

  // Assigned every render so these closures always see CURRENT state setters —
  // memoized callbacks call through the refs instead of capturing directly.
  watchFloorSilenceRef.current = (sess: SttSession) => {
    clearSilenceTimer();
    silenceTimerRef.current = setInterval(() => {
      const st = sess.getState();
      // ONE definition of "what the candidate has said on this floor", shared
      // with endFloor's transcript builder below. They used to disagree: the
      // builder kept non-echo pre-adoption finals — the early-start words that
      // made this a floor in the first place — while this watchdog counted only
      // post-adoption ones. So every early-start interjection looked SILENT
      // here and sat out the full GD_EMPTY_FLOOR_MS timeout with its own words
      // already in the transcript: a five-second dead room after every jump-in.
      const finals = candidateFinals(st.finalSegments, floorAdoptRef.current);
      const hasSpeech = finals.length > 0 || st.interim.trim().length > 0;
      // The silence anchor can never predate the floor itself.
      const lastSpeech = Math.max(st.lastSpeechT ?? 0, floorStartTRef.current);
      if (hasSpeech && Date.now() - lastSpeech > GD_SILENCE_MS) {
        void endFloorRef.current();
      } else if (!hasSpeech && Date.now() - floorStartTRef.current > GD_EMPTY_FLOOR_MS) {
        // Grabbed the floor and said nothing — hand it back, don't stall the room.
        void endFloorRef.current();
      }
    }, 250);
  };

  adoptFloorRef.current = (sess: SttSession | null, echoRef: string | null) => {
    if (!sess || endedRef.current || floorActiveRef.current || floorSettlingRef.current) return;
    // The single funnel for the candidate taking the floor — so it is also the
    // single place that kills what the room had queued up to say instead: any
    // moderator ack still masking a fetch, and the next persona line rendered
    // ahead of time (its batch is stale the moment the candidate speaks).
    ackRef.current?.cancel();
    ackRef.current = null;
    dropPrepared();
    floorActiveRef.current = true;
    floorStartTRef.current = Date.now();
    sttFloorRef.current = sess;
    // Every floor gets its OWN deferred (never a dying one from the previous
    // floor's settle window — that reuse spun the loop forever).
    floorDoneRef.current = deferred();
    floorAdoptRef.current = echoRef !== null ? { finals: sess.getState().finalSegments.length, echoRef } : null;
    setCandidateHasFloor(true);
    setActiveSpeaker("candidate");
    setCaption(null);
    setLastSentence("");
    watchFloorSilenceRef.current(sess);
  };

  endFloorRef.current = async () => {
    if (!floorActiveRef.current) return;
    floorActiveRef.current = false; // first thing — silence timer and Enter race
    floorSettlingRef.current = true; // …but the floor is not FREE until settled
    // Captured now: only THIS floor's deferred is resolved at the end, even if
    // something else has replaced the ref meanwhile.
    const d = floorDoneRef.current;
    clearSilenceTimer();
    const sess = sttFloorRef.current;
    sttFloorRef.current = null;
    const adopted = floorAdoptRef.current;
    floorAdoptRef.current = null;
    setCandidateHasFloor(false);
    try {
      if (sess) {
        const st = await sess.stopAndSettle();
        if (endedRef.current) return;
        // Drop what the mic heard BEFORE adoption when it is the persona's
        // own line through the speakers; keep genuine interruption words.
        const finals = candidateFinals(st.finalSegments, adopted);
        const text = [...finals, st.interim].join(" ").replace(/\s+/g, " ").trim();
        if (text) {
          // The turn starts at the first word that was actually THEIRS. Taking
          // the first result in the trace instead backdated every floor to the
          // persona's echo — the mic has been live since that persona started —
          // which inflated the candidate's airtime by whole persona lines and
          // made even a late, polite turn score as an interjection.
          pushTurn({
            speaker: "candidate",
            text,
            tStart: candidateTurnStart(st.trace, floorStartTRef.current, adopted),
            tEnd: Math.max(st.lastSpeechT ?? 0, floorStartTRef.current) || Date.now(),
          });
          historyRef.current.push({ personaId: "candidate", text });
          historyVersionRef.current++; // stale-batch fence: in-flight fetches predate this point
          // Moderator-voice "mm-hm" masks the fetch — never over a persona
          // that is still speaking.
          if (!turnCtxRef.current) ackRef.current = playAck();
        }
      }
    } finally {
      floorSettlingRef.current = false;
      setActiveSpeaker(null);
      setLastSentence("");
      if (floorDoneRef.current === d) floorDoneRef.current = null;
      d?.resolve();
    }
  };

  return {
    phase,
    activeSpeaker,
    caption,
    thinking,
    hearing,
    lastSentence,
    micCheckTranscript,
    micBlocked,
    engineNotice,
    transcript,
    metrics,
    candidateHasFloor,
    discussionStartedAt,
    session,
    sessionPersisted,
    personas: GD_PERSONAS,
    beginMicCheck,
    confirmMicCheck,
    startDiscussion,
    takeFloor,
    endFloorNow,
    cleanup,
  };
}
