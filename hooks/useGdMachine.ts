"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GdHistoryEntry, GdMetrics, GdPersona, GdRequest, GdTurn, Session, Turn } from "@/lib/types";
import { computeGdTurns, GD_WRAP_AFTER, gdWrapup, isGdWrapTurn } from "@/lib/gd/flow";
import { GD_PERSONAS, gdPersona } from "@/lib/gd/personas";
import { airtimeFromTurns, composeGdVerdict } from "@/lib/gd/airtime";
import { startStt, type SttSession } from "@/lib/stt";
import { fullTranscript, type SttState } from "@/lib/stt-reducer";
import { speak, type SpeakHandle } from "@/lib/tts";
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

export type GdPhase = "micCheck" | "preroll" | "discussion" | "wrapup" | "done";

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
  /** Warning-card text: STT degrade reason, or the server's 429 message. */
  micBlocked: string | null;
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
  const turnCtxRef = useRef<{ handle: SpeakHandle; promoted: { v: boolean } } | null>(null);
  const floorActiveRef = useRef(false);
  const floorStartTRef = useRef(0);
  const floorDoneRef = useRef<Deferred | null>(null);
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
  const adoptFloorRef = useRef<(sess: SttSession | null) => void>(() => {});
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
    stopMicViz();
    setVizMode("idle");
  }, []);

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

  const beginMicCheck = useCallback(() => {
    if (micCheckSttRef.current) return;
    setMicBlocked(null);
    const sess = startStt({
      onUpdate: (s: SttState) => {
        setMicCheckTranscript(fullTranscript(s));
        setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
      },
      onDegrade: (reason) => {
        micCheckSttRef.current = null;
        setMicBlocked(reason);
      },
    });
    micCheckSttRef.current = sess;
  }, []);

  const confirmMicCheck = useCallback(() => {
    try {
      micCheckSttRef.current?.stop();
    } catch {}
    micCheckSttRef.current = null;
    // Permission is granted by now — open the orb's true-amplitude mic tap and
    // pre-generate moderator-voice acks (the latency mask after interjections).
    void startMicViz();
    resetAcks();
    void prepareAcks(gdPersona("moderator")?.voice);
    toPhase("preroll");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        setMicBlocked(reason);
        void endFloorRef.current();
      },
    });
  }, []);

  /** Explicit floor-grab (SPACE / button). Mid-persona-turn it cancels the
   * speaker and adopts the already-live interrupt mic; in a gap it opens a
   * fresh session — the batch loop waits for the floor before continuing. */
  const takeFloor = useCallback(() => {
    if (endedRef.current || floorActiveRef.current) return;
    if (phaseRef.current !== "discussion" && phaseRef.current !== "wrapup") return;
    const ctx = turnCtxRef.current;
    if (ctx) {
      if (ctx.promoted.v) return;
      ctx.promoted.v = true;
      const sess = interruptSttRef.current;
      interruptSttRef.current = null;
      ctx.handle.cancel();
      adoptFloorRef.current(sess ?? startFloorStt());
    } else {
      adoptFloorRef.current(startFloorStt());
    }
  }, [startFloorStt]);

  const endFloorNow = useCallback(() => {
    if (floorActiveRef.current) void endFloorRef.current();
  }, []);

  const waitFloor = useCallback(async () => {
    const d = floorDoneRef.current;
    if (d) await d.promise;
  }, []);

  // ——— persona speech ———

  /** Speak one persona turn with the mic LIVE against it. Resolves "interjected"
   * when the candidate took the floor (barge-in, SPACE, or early start). */
  const playPersonaTurn = useCallback(
    async (turn: GdTurn): Promise<"completed" | "interjected" | "ended"> => {
      if (endedRef.current) return "ended";
      const persona = gdPersona(turn.personaId);
      const name = persona?.name ?? turn.personaId;
      setThinking(false);
      setCaption({ speaker: name, text: turn.text });
      setActiveSpeaker(turn.personaId);

      // Let a pending ack finish before the persona starts (overlap garbles).
      if (ackRef.current) {
        await ackRef.current.done;
        ackRef.current = null;
        if (endedRef.current) return "ended";
      }

      const handle = speak(turn.text, { voice: persona?.voice, hue: persona?.hue });
      speakRef.current = handle;
      ttsTurnStartRef.current = null;
      handle.firstSyllableAt.then((t) => {
        ttsTurnStartRef.current = t;
      });

      // Live mic for the whole turn: sustained non-echo speech = barge-in.
      // The CURRENT persona's text is the echo reference (pinned contract).
      const promoted = { v: false };
      turnCtxRef.current = { handle, promoted };
      const holder: { sess: SttSession | null } = { sess: null };
      holder.sess = startStt({
        onUpdate: (s: SttState) => {
          setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
          if (promoted.v) {
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
            promoted.v = true;
            interruptSttRef.current = null;
            handle.cancel();
            adoptFloorRef.current(holder.sess);
          }
        },
        onDegrade: (reason) => {
          micTroubleRef.current = true;
          // Pre-promotion listener death is not fatal (1:1 rule) — the next
          // floor attempt starts fresh and reports properly if it persists.
          if (!promoted.v) {
            interruptSttRef.current = null;
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

      // Recorded even when cut off — tEnd marks where the voice stopped, which
      // is exactly what the interjection-overlap metric needs.
      pushTurn({ speaker: "interviewer", text: turn.text, tStart, tEnd, personaId: turn.personaId, personaName: name });
      historyRef.current.push({ personaId: turn.personaId, text: turn.text });
      personaTurnCountRef.current++;

      if (promoted.v) return "interjected";

      const isess = interruptSttRef.current;
      interruptSttRef.current = null;
      if (isess) {
        const heard = fullTranscript(isess.getState());
        if (heard.trim() && echoOverlap(heard, turn.text) < ECHO_OVERLAP_THRESHOLD) {
          // Early start: the candidate began during the tail of the turn.
          adoptFloorRef.current(isess);
          return "interjected";
        }
        try {
          isess.stop(); // echo or noise — discard
        } catch {}
      }
      setActiveSpeaker(null);
      return "completed";
    },
    [pushTurn],
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
        // Rate-limited: show the server's own message on the warning card —
        // the scripted rescue below keeps the room alive, but never silently.
        const err = (await res.json().catch(() => null)) as { message?: string } | null;
        const msg = err?.message ?? "The debate engine is rate-limited — continuing with scripted turns.";
        rateLimit429Ref.current = msg;
        setMicBlocked(msg);
        throw new Error("api_429");
      }
      if (!res.ok) throw new Error(`api_${res.status}`);
      const data = (await res.json()) as { turns?: GdTurn[] };
      if (!Array.isArray(data.turns)) throw new Error("bad_shape");
      if (rateLimit429Ref.current !== null) {
        // Recovered — clear the 429 message, but never a real mic warning.
        const shown = rateLimit429Ref.current;
        rateLimit429Ref.current = null;
        setMicBlocked((cur) => (cur === shown ? null : cur));
      }
      return data.turns;
    } catch {
      // The room never dies: the scripted engine is isomorphic — run it here.
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
    // Never wrap OVER the candidate — wait out an active floor first.
    while (floorActiveRef.current) {
      await waitFloor();
      if (endedRef.current) return;
    }
    const r = await playPersonaTurn({ personaId: "moderator", text: gdWrapup(topic, candidateName) });
    if (r === "ended") return;
    if (r === "interjected") {
      // Let them land the last word, then close anyway.
      await waitFloor();
      if (endedRef.current) return;
    }
    finishDiscussion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateName, finishDiscussion, playPersonaTurn, topic, waitFloor]);

  const runDiscussion = useCallback(async () => {
    const startT = Date.now();
    discussionStartTRef.current = startT;
    setDiscussionStartedAt(startT);
    const overTime = () => Date.now() - startT >= GD_CAP_MS;

    // Deterministic opening — instant, no network, kills session-start dead air.
    for (const t of computeGdTurns(topic, candidateName, [], 1)) {
      const r = await playPersonaTurn(t);
      if (r === "ended") return;
      if (r === "interjected") {
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
      const batchVersion = historyVersionRef.current; // what this fetch knows
      const batch = await fetchBatch();
      setThinking(false);
      if (endedRef.current) return;
      // The candidate grabbed the floor during the fetch — this batch is stale
      // (it doesn't react to what they're saying). Wait, then fetch fresh.
      if (floorActiveRef.current) {
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
      for (const t of batch) {
        if (endedRef.current) return;
        if (overTime()) break;
        // Floor grabbed between persona turns: never speak over the candidate.
        while (floorActiveRef.current) {
          await waitFloor();
          if (endedRef.current) return;
        }
        // If they said anything, the rest of this batch is stale — refetch.
        if (historyVersionRef.current !== batchVersion) break;
        const r = await playPersonaTurn(t);
        if (r === "ended") return;
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
  }, [candidateName, doWrap, fetchBatch, finishDiscussion, playPersonaTurn, topic, waitFloor]);

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
      const hasSpeech = st.finalSegments.length > 0 || st.interim.trim().length > 0;
      if (st.lastSpeechT && hasSpeech && Date.now() - st.lastSpeechT > GD_SILENCE_MS) {
        void endFloorRef.current();
      } else if (!hasSpeech && Date.now() - floorStartTRef.current > GD_EMPTY_FLOOR_MS) {
        // Grabbed the floor and said nothing — hand it back, don't stall the room.
        void endFloorRef.current();
      }
    }, 250);
  };

  adoptFloorRef.current = (sess: SttSession | null) => {
    if (!sess || endedRef.current || floorActiveRef.current) return;
    floorActiveRef.current = true;
    floorStartTRef.current = Date.now();
    sttFloorRef.current = sess;
    floorDoneRef.current = floorDoneRef.current ?? deferred();
    setCandidateHasFloor(true);
    setActiveSpeaker("candidate");
    setCaption(null);
    setLastSentence("");
    watchFloorSilenceRef.current(sess);
  };

  endFloorRef.current = async () => {
    if (!floorActiveRef.current) return;
    floorActiveRef.current = false; // first thing — silence timer and Enter race
    clearSilenceTimer();
    const sess = sttFloorRef.current;
    sttFloorRef.current = null;
    setCandidateHasFloor(false);
    if (sess) {
      const st = await sess.stopAndSettle();
      if (endedRef.current) return;
      const text = fullTranscript(st).trim();
      if (text) {
        // The turn starts at the first heard word (they may have begun while
        // the persona was still talking — that's what makes it an interjection).
        const firstResult = st.trace.find((e) => e.kind === "result");
        pushTurn({
          speaker: "candidate",
          text,
          tStart: firstResult ? firstResult.t : floorStartTRef.current,
          tEnd: st.lastSpeechT ?? Date.now(),
        });
        historyRef.current.push({ personaId: "candidate", text });
        historyVersionRef.current++; // stale-batch fence: in-flight fetches predate this point
        ackRef.current = playAck(); // moderator-voice "mm-hm" masks the fetch
      }
    }
    setActiveSpeaker(null);
    setLastSentence("");
    const d = floorDoneRef.current;
    floorDoneRef.current = null;
    d?.resolve();
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
