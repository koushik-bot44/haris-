"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeliveryMetrics,
  HistoryEntry,
  InterviewerTurn,
  RolePreset,
  RubricEntry,
  Session,
  SttTraceEvent,
  Turn,
} from "@/lib/types";
import { composeOverall } from "@/lib/rubric";
import { startStt, type SttSession } from "@/lib/stt";
import { fullTranscript, type SttState } from "@/lib/stt-reducer";
import { speak, type SpeakHandle } from "@/lib/tts";
import { decideBargeIn, echoOverlap, ECHO_OVERLAP_THRESHOLD } from "@/lib/barge-in";
import { aggregateMetrics, computeDeliveryMetrics, METRICS_VERSION } from "@/lib/metrics";
import { newSessionId, saveSession } from "@/lib/session-store";
import { VERBAL_ACKS } from "@/lib/fixtures/hr-questions";

// The interview room state machine from the plan:
// micCheck → preroll → thinking → speaking → listening → … → done
// Turn-taking is automatic: the 1.5s silence timer ends an answer; the only
// controls are "end answer now" and "leave". No mic toggle — a toggle would
// lie about the interaction model.

export type Phase =
  | "micCheck"
  | "preroll"
  | "thinking"
  | "speaking"
  | "listening"
  | "connectionLost"
  | "done";

export const SILENCE_MS = 1500;

interface AnswerRecord {
  transcript: string;
  trace: SttTraceEvent[];
}

export interface InterviewMachine {
  phase: Phase;
  textMode: boolean;
  degradeReason: string | null;
  caption: string; // current interviewer line (always rendered — captions are a11y)
  lastSentence: string; // low-emphasis proof-of-hearing (live transcript stays hidden)
  hearing: boolean;
  questionIndex: number;
  turnCount: number;
  latencies: number[];
  avgLatencyMs: number | null;
  micCheckTranscript: string;
  session: Session | null;
  /** Live rubric entries as background scoring resolves (may trail the session). */
  scores: RubricEntry[];
  /** false = localStorage unavailable; the summary must say so and push the download. */
  sessionPersisted: boolean;
  /** Partial transcript rescued when STT degraded mid-answer — seeds the textarea. */
  degradePrefill: string;
  error: string | null;
  beginMicCheck: () => void;
  confirmMicCheck: () => void;
  switchToTextMode: () => void;
  retryVoice: () => void;
  startInterview: () => void;
  endAnswerNow: () => void;
  submitTextAnswer: (text: string) => void;
  retryConnection: () => void;
  cleanup: () => void;
}

export function useInterviewMachine(candidateName: string, role: RolePreset): InterviewMachine {
  const [phase, setPhase] = useState<Phase>("micCheck");
  const [textMode, setTextMode] = useState(false);
  const [degradeReason, setDegradeReason] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [lastSentence, setLastSentence] = useState("");
  const [hearing, setHearing] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [micCheckTranscript, setMicCheckTranscript] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [sessionPersisted, setSessionPersisted] = useState(true);
  const [degradePrefill, setDegradePrefill] = useState("");
  const [error, setError] = useState<string | null>(null);

  const historyRef = useRef<HistoryEntry[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  const answersRef = useRef<AnswerRecord[]>([]);
  const sttRef = useRef<SttSession | null>(null);
  const micCheckSttRef = useRef<SttSession | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speakRef = useRef<SpeakHandle | null>(null);
  const ackRef = useRef<SpeakHandle | null>(null);
  const answerStartTRef = useRef(0);
  const answerEndTRef = useRef<number | null>(null);
  const ackCounterRef = useRef(0);
  const endedRef = useRef(false);
  const startedRef = useRef(false);
  const textModeRef = useRef(false);
  /** Trace captured when STT degraded mid-answer — merged into the text-mode submit. */
  const pendingTraceRef = useRef<SttTraceEvent[]>([]);
  /** Live mic session that runs WHILE Priya speaks — barge-in + early-start capture. */
  const interruptSttRef = useRef<SttSession | null>(null);
  const ttsTurnStartRef = useRef<number | null>(null);
  // Background scoring state: one rubric entry per main question; follow-up
  // answers concatenate onto the parent and trigger a re-score (last wins).
  const currentQuestionRef = useRef<{ id: number; text: string } | null>(null);
  const combinedAnswersRef = useRef<Map<number, string>>(new Map());
  const scoreSeqRef = useRef<Map<number, number>>(new Map());
  const scoresRef = useRef<Map<number, RubricEntry>>(new Map());
  const tooShortRef = useRef<Set<number>>(new Set());
  const pendingScoresRef = useRef<Promise<void>[]>([]);
  const [scores, setScores] = useState<RubricEntry[]>([]);
  // Fresh-closure helpers assigned every render (see bottom of hook) so memoized
  // callbacks never capture a stale endAnswer — the exact bug class the
  // adversarial review confirmed in this file.
  const watchSilenceRef = useRef<(sess: SttSession) => void>(() => {});
  const adoptSessionRef = useRef<(sess: SttSession) => void>(() => {});

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
      sttRef.current?.stop();
      micCheckSttRef.current?.stop();
      interruptSttRef.current?.stop();
    } catch {}
    speakRef.current?.cancel();
    ackRef.current?.cancel();
  }, []);

  // StrictMode runs mount → cleanup → mount in dev. The refs survive that
  // simulated remount, so the flags MUST be re-armed in the effect setup or
  // the machine is permanently dead before the user clicks anything.
  useEffect(() => {
    endedRef.current = false;
    startedRef.current = false;
    return cleanup;
  }, [cleanup]);

  const degradeToText = useCallback((reason: string) => {
    textModeRef.current = true;
    setTextMode(true);
    setDegradeReason(reason);
  }, []);

  // ——— mic check ———

  const beginMicCheck = useCallback(() => {
    if (micCheckSttRef.current) return;
    const sess = startStt({
      onUpdate: (s: SttState) => {
        setMicCheckTranscript(fullTranscript(s));
        setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
      },
      onDegrade: (reason) => {
        micCheckSttRef.current = null;
        degradeToText(reason);
      },
    });
    micCheckSttRef.current = sess;
  }, [degradeToText]);

  const confirmMicCheck = useCallback(() => {
    try {
      micCheckSttRef.current?.stop();
    } catch {}
    micCheckSttRef.current = null;
    setPhase("preroll");
  }, []);

  /** The road back: mic problems must never be a one-way door into text mode.
   * Re-arms voice; from mic-check the user re-runs the check, mid-interview
   * the current answer restarts listening immediately. */
  const retryVoice = useCallback(() => {
    textModeRef.current = false;
    setTextMode(false);
    setDegradeReason(null);
    setMicCheckTranscript("");
    if (phase === "listening") beginListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const switchToTextMode = useCallback(() => {
    try {
      micCheckSttRef.current?.stop();
    } catch {}
    micCheckSttRef.current = null;
    if (phase === "listening" && sttRef.current) {
      // Same rescue as onDegrade: what was already spoken prefills the textarea.
      clearSilenceTimer();
      const captured = sttRef.current.stop();
      sttRef.current = null;
      setDegradePrefill(fullTranscript(captured));
      pendingTraceRef.current = captured.trace;
    }
    degradeToText("user_choice");
    if (phase === "micCheck") setPhase("preroll");
  }, [degradeToText, phase]);

  // ——— interviewer loop ———

  const finishInterview = useCallback(async () => {
    cleanup();
    // Scoring ran in the background during the interview; give stragglers a
    // short grace window so the saved session carries the full scorecard.
    await Promise.race([
      Promise.allSettled(pendingScoresRef.current),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    const scoredEntries = [...scoresRef.current.values()].sort((a, b) => a.questionId - b.questionId);
    const perAnswer: DeliveryMetrics[] = answersRef.current.map((a) =>
      computeDeliveryMetrics(a.trace, a.transcript),
    );
    const lat = latenciesRef();
    const s: Session = {
      _id: newSessionId(),
      userId: null,
      role,
      roundType: "hr",
      codingUsed: false,
      startedAt: turnsRef.current[0]?.tStart ?? Date.now(),
      turns: turnsRef.current,
      perQuestionScores: scoredEntries,
      deliveryMetrics: aggregateMetrics(perAnswer),
      metricsVersion: METRICS_VERSION,
      latency: {
        perTurnMs: lat,
        avgMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      },
      overall: composeOverall(scoredEntries),
    };
    const { persisted } = saveSession(s);
    setSessionPersisted(persisted);
    setSession(s);
    setPhase("done");
  }, [cleanup, role]);

  const latListRef = useRef<number[]>([]);
  const latenciesRef = () => latListRef.current;

  const beginListening = useCallback(() => {
    if (endedRef.current) return;
    setLastSentence("");
    setDegradePrefill("");
    pendingTraceRef.current = [];
    answerStartTRef.current = Date.now();
    setPhase("listening");
    if (textModeRef.current) return; // textarea path — page renders the input

    const sess = startStt({
      onUpdate: (s: SttState) => {
        const lastFinal = s.finalSegments[s.finalSegments.length - 1] ?? "";
        setLastSentence(lastFinal);
        setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
      },
      onDegrade: (reason) => {
        clearSilenceTimer();
        // Capture BEFORE discarding the session — 45 seconds of a spoken
        // answer must not vanish because the recognizer died. The partial
        // transcript prefills the textarea; the trace rides along so metrics
        // still cover the spoken part.
        const captured = sttRef.current?.getState();
        sttRef.current = null;
        if (captured) {
          setDegradePrefill(fullTranscript(captured));
          pendingTraceRef.current = captured.trace;
        }
        degradeToText(reason);
      },
    });
    sttRef.current = sess;
    if (!sess) return;
    watchSilenceRef.current(sess);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [degradeToText]);

  const fireScoring = useCallback((qid: number, question: string, combinedAnswer: string) => {
    const seq = (scoreSeqRef.current.get(qid) ?? 0) + 1;
    scoreSeqRef.current.set(qid, seq);
    const p = fetch("/api/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: qid, question, answer: combinedAnswer }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { entry?: RubricEntry; tooShort?: boolean } | null) => {
        if (!d || scoreSeqRef.current.get(qid) !== seq) return; // stale response
        if (d.tooShort) tooShortRef.current.add(qid);
        else if (d.entry) {
          tooShortRef.current.delete(qid);
          scoresRef.current.set(qid, d.entry);
        }
        setScores([...scoresRef.current.values()].sort((a, b) => a.questionId - b.questionId));
      })
      .catch(() => {}); // scoring is best-effort; the round never depends on it
    pendingScoresRef.current.push(p);
  }, []);

  const recordAnswer = useCallback(
    (transcript: string, trace: SttTraceEvent[], endT: number) => {
      const text = transcript.trim() || "(no answer)";
      historyRef.current.push({ speaker: "candidate", text });
      turnsRef.current.push({
        speaker: "candidate",
        text,
        tStart: answerStartTRef.current,
        tEnd: Date.now(),
      });
      answersRef.current.push({ transcript: text, trace });
      answerEndTRef.current = endT;

      // Background scoring: follow-up answers concatenate onto the parent
      // question's transcript (plan: one rubric entry per questionId).
      const q = currentQuestionRef.current;
      if (q && text !== "(no answer)") {
        const combined = [combinedAnswersRef.current.get(q.id), text].filter(Boolean).join(" ");
        combinedAnswersRef.current.set(q.id, combined);
        fireScoring(q.id, q.text, combined);
      }
    },
    [fireScoring],
  );

  const speakAck = useCallback(() => {
    const ack = VERBAL_ACKS[ackCounterRef.current % VERBAL_ACKS.length];
    ackCounterRef.current += 1;
    ackRef.current = speak(ack);
  }, []);

  const callInterviewer = useCallback(async () => {
    if (endedRef.current) return;
    setPhase("thinking");
    setError(null);
    let turn: InterviewerTurn;
    try {
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role,
          roundType: "hr",
          candidateName,
          history: historyRef.current,
        }),
      });
      if (!res.ok) throw new Error(`api_${res.status}`);
      const data = (await res.json()) as { turn: InterviewerTurn };
      turn = data.turn;
    } catch {
      // A retried turn must not record the outage + human reaction time as
      // interviewer latency — drop the anchor for this turn.
      answerEndTRef.current = null;
      if (!endedRef.current) setPhase("connectionLost");
      return;
    }
    if (endedRef.current) return;

    historyRef.current.push({ speaker: "interviewer", text: turn.text });
    const tStart = Date.now();
    setCaption(turn.text);
    setQuestionIndex(turn.questionIndex);
    // Track which main question the next answer belongs to (scoring identity):
    // a follow-up keeps the parent question's id and text.
    if (turn.type === "question") {
      currentQuestionRef.current = { id: turn.questionIndex || (currentQuestionRef.current?.id ?? 0) + 1, text: turn.text };
    } else if (turn.type === "followup" && currentQuestionRef.current === null) {
      currentQuestionRef.current = { id: Math.max(1, turn.questionIndex), text: turn.text };
    }
    setPhase("speaking");

    // Let the verbal ack finish before the real reply starts (both share the
    // global speechSynthesis queue; overlapping them garbles the audio).
    if (ackRef.current) {
      await ackRef.current.done;
      ackRef.current = null;
    }
    // The user may have left during the ack — every suspension point needs the
    // guard, or the next question speaks over the home page.
    if (endedRef.current) return;

    const handle = speak(turn.text);
    speakRef.current = handle;
    ttsTurnStartRef.current = null;
    handle.firstSyllableAt.then((t) => {
      ttsTurnStartRef.current = t;
    });

    // Latency = student's last word → interviewer's first syllable (plan anchor).
    if (answerEndTRef.current !== null) {
      const endT = answerEndTRef.current;
      answerEndTRef.current = null;
      handle.firstSyllableAt.then((t) => {
        if (endedRef.current) return;
        latListRef.current = [...latListRef.current, Math.max(0, t - endT)];
        setLatencies(latListRef.current);
      });
    }

    // Real-time conversation: the mic stays LIVE while Priya speaks. Sustained,
    // non-echo candidate speech cancels her mid-sentence (barge-in — she stops
    // and listens like a real interviewer); a quieter early start is captured
    // and becomes the beginning of the answer instead of being lost.
    const promo = { promoted: false };
    if (!textModeRef.current && !turn.done) {
      const holder: { sess: SttSession | null } = { sess: null };
      holder.sess = startStt({
        onUpdate: (s: SttState) => {
          setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
          if (promo.promoted) {
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
            promo.promoted = true;
            interruptSttRef.current = null;
            handle.cancel();
            adoptSessionRef.current(holder.sess);
          }
        },
        onDegrade: (reason) => {
          if (!promo.promoted) {
            // The live-mic listener dying pre-promotion is not fatal — the
            // normal post-TTS beginListening() will start fresh and degrade
            // properly if the problem persists.
            interruptSttRef.current = null;
            return;
          }
          clearSilenceTimer();
          const captured = sttRef.current?.getState();
          sttRef.current = null;
          if (captured) {
            setDegradePrefill(fullTranscript(captured));
            pendingTraceRef.current = captured.trace;
          }
          degradeToText(reason);
        },
      });
      interruptSttRef.current = holder.sess;
    }

    await handle.done;
    turnsRef.current.push({ speaker: "interviewer", text: turn.text, tStart, tEnd: Date.now() });
    if (endedRef.current) return;

    if (turn.done) {
      finishInterview();
    } else if (promo.promoted) {
      // Barge-in already adopted the live mic session and moved us to listening.
    } else {
      const isess = interruptSttRef.current;
      interruptSttRef.current = null;
      if (isess) {
        const heard = fullTranscript(isess.getState());
        if (heard.trim() && echoOverlap(heard, turn.text) < ECHO_OVERLAP_THRESHOLD) {
          // Early start: the candidate began answering before Priya finished.
          adoptSessionRef.current(isess);
          return;
        }
        try {
          isess.stop(); // echo or noise — discard
        } catch {}
      }
      beginListening();
    }
  }, [beginListening, candidateName, degradeToText, finishInterview, role]);

  const endAnswer = useCallback(async () => {
    clearSilenceTimer();
    const sess = sttRef.current;
    sttRef.current = null;
    if (!sess) return;
    // Speak the ack immediately (the latency mask), then let Chrome finalize
    // buffered audio — the last words of the answer arrive AFTER stop().
    speakAck();
    const st = await sess.stopAndSettle();
    if (endedRef.current) return;
    const transcript = fullTranscript(st);
    recordAnswer(transcript, st.trace, st.lastSpeechT ?? Date.now());
    void callInterviewer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callInterviewer, recordAnswer, speakAck]);

  const endAnswerNow = useCallback(() => {
    if (phase !== "listening") return;
    if (textModeRef.current) return; // text mode submits via the textarea
    void endAnswer();
  }, [endAnswer, phase]);

  const submitTextAnswer = useCallback(
    (text: string) => {
      if (phase !== "listening") return;
      // If STT degraded mid-answer, the captured trace still covers the spoken
      // part — merge it so delivery metrics survive the degrade.
      recordAnswer(text, pendingTraceRef.current, Date.now());
      pendingTraceRef.current = [];
      setDegradePrefill("");
      speakAck();
      void callInterviewer();
    },
    [callInterviewer, phase, recordAnswer, speakAck],
  );

  // Assigned every render so these closures always see the CURRENT endAnswer —
  // memoized callbacks call through the ref instead of capturing directly.
  watchSilenceRef.current = (sess: SttSession) => {
    clearSilenceTimer();
    silenceTimerRef.current = setInterval(() => {
      const st = sess.getState();
      const hasSpeech = st.finalSegments.length > 0 || st.interim.trim().length > 0;
      if (st.lastSpeechT && hasSpeech && Date.now() - st.lastSpeechT > SILENCE_MS) {
        void endAnswer();
      }
    }, 250);
  };
  adoptSessionRef.current = (sess: SttSession) => {
    setDegradePrefill("");
    pendingTraceRef.current = [];
    setLastSentence("");
    answerStartTRef.current = Date.now();
    sttRef.current = sess;
    setPhase("listening");
    watchSilenceRef.current(sess);
  };

  const startInterview = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void callInterviewer();
  }, [callInterviewer]);

  const retryConnection = useCallback(() => {
    void callInterviewer();
  }, [callInterviewer]);

  const avgLatencyMs = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  return {
    phase,
    textMode,
    degradeReason,
    caption,
    lastSentence,
    hearing,
    questionIndex,
    turnCount: turnsRef.current.length,
    latencies,
    avgLatencyMs,
    micCheckTranscript,
    session,
    scores,
    sessionPersisted,
    degradePrefill,
    error,
    beginMicCheck,
    confirmMicCheck,
    switchToTextMode,
    retryVoice,
    startInterview,
    endAnswerNow,
    submitTextAnswer,
    retryConnection,
    cleanup,
  };
}
