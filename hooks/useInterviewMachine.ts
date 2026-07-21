"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeliveryMetrics,
  HistoryEntry,
  InterviewerTurn,
  RolePreset,
  Session,
  SttTraceEvent,
  Turn,
} from "@/lib/types";
import { startStt, type SttSession } from "@/lib/stt";
import { fullTranscript, type SttState } from "@/lib/stt-reducer";
import { speak, type SpeakHandle } from "@/lib/tts";
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
  error: string | null;
  beginMicCheck: () => void;
  confirmMicCheck: () => void;
  switchToTextMode: () => void;
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
    } catch {}
    speakRef.current?.cancel();
    ackRef.current?.cancel();
  }, []);

  useEffect(() => cleanup, [cleanup]);

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

  const switchToTextMode = useCallback(() => {
    try {
      micCheckSttRef.current?.stop();
      sttRef.current?.stop();
    } catch {}
    micCheckSttRef.current = null;
    degradeToText("user_choice");
    if (phase === "listening") {
      clearSilenceTimer();
    } else if (phase === "micCheck") {
      setPhase("preroll");
    }
  }, [degradeToText, phase]);

  // ——— interviewer loop ———

  const finishInterview = useCallback(() => {
    cleanup();
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
      perQuestionScores: [], // rubric scoring lands in M1 weekend 2
      deliveryMetrics: aggregateMetrics(perAnswer),
      metricsVersion: METRICS_VERSION,
      latency: {
        perTurnMs: lat,
        avgMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      },
      overall: { avgScore: null, summary: "Scoring arrives with weekend 2 — transcript and delivery metrics below." },
    };
    saveSession(s);
    setSession(s);
    setPhase("done");
  }, [cleanup, role]);

  const latListRef = useRef<number[]>([]);
  const latenciesRef = () => latListRef.current;

  const beginListening = useCallback(() => {
    if (endedRef.current) return;
    setLastSentence("");
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
        sttRef.current = null;
        degradeToText(reason);
        // The answer continues in text mode; whatever was already transcribed
        // is preserved and prefills the textarea via degrade state on the page.
      },
    });
    sttRef.current = sess;
    if (!sess) return;

    clearSilenceTimer();
    silenceTimerRef.current = setInterval(() => {
      const st = sess.getState();
      const hasSpeech = st.finalSegments.length > 0 || st.interim.trim().length > 0;
      if (st.lastSpeechT && hasSpeech && Date.now() - st.lastSpeechT > SILENCE_MS) {
        endAnswer();
      }
    }, 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [degradeToText]);

  const recordAnswer = useCallback((transcript: string, trace: SttTraceEvent[], endT: number) => {
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
  }, []);

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
      if (!endedRef.current) setPhase("connectionLost");
      return;
    }
    if (endedRef.current) return;

    historyRef.current.push({ speaker: "interviewer", text: turn.text });
    const tStart = Date.now();
    setCaption(turn.text);
    setQuestionIndex(turn.questionIndex);
    setPhase("speaking");

    // Let the verbal ack finish before the real reply starts (both share the
    // global speechSynthesis queue; overlapping them garbles the audio).
    if (ackRef.current) {
      await ackRef.current.done;
      ackRef.current = null;
    }

    const handle = speak(turn.text);
    speakRef.current = handle;

    // Latency = student's last word → interviewer's first syllable (plan anchor).
    if (answerEndTRef.current !== null) {
      const endT = answerEndTRef.current;
      answerEndTRef.current = null;
      handle.firstSyllableAt.then((t) => {
        latListRef.current = [...latListRef.current, Math.max(0, t - endT)];
        setLatencies(latListRef.current);
      });
    }

    await handle.done;
    turnsRef.current.push({ speaker: "interviewer", text: turn.text, tStart, tEnd: Date.now() });
    if (endedRef.current) return;

    if (turn.done) {
      finishInterview();
    } else {
      beginListening();
    }
  }, [beginListening, candidateName, finishInterview, role]);

  const endAnswer = useCallback(() => {
    clearSilenceTimer();
    const sess = sttRef.current;
    sttRef.current = null;
    if (!sess) return;
    const st = sess.stop();
    const transcript = fullTranscript(st);
    recordAnswer(transcript, st.trace, st.lastSpeechT ?? Date.now());
    speakAck();
    void callInterviewer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callInterviewer, recordAnswer, speakAck]);

  const endAnswerNow = useCallback(() => {
    if (phase !== "listening") return;
    if (textModeRef.current) return; // text mode submits via the textarea
    endAnswer();
  }, [endAnswer, phase]);

  const submitTextAnswer = useCallback(
    (text: string) => {
      if (phase !== "listening") return;
      recordAnswer(text, [], Date.now());
      speakAck();
      void callInterviewer();
    },
    [callInterviewer, phase, recordAnswer, speakAck],
  );

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
    error,
    beginMicCheck,
    confirmMicCheck,
    switchToTextMode,
    startInterview,
    endAnswerNow,
    submitTextAnswer,
    retryConnection,
    cleanup,
  };
}
