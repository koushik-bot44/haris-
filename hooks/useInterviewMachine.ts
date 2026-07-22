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
import { getSttEngine, setSttEngineEphemeral, startStt, type SttSession } from "@/lib/stt";
import { ensureWhisperLoading } from "@/lib/stt-whisper";
import { fullTranscript, type SttState } from "@/lib/stt-reducer";
import { prepareSpeak, speak, type PreparedSpeech, type SpeakHandle } from "@/lib/tts";
import { decideBargeIn, echoOverlap, ECHO_OVERLAP_THRESHOLD } from "@/lib/barge-in";
import { aggregateMetrics, computeDeliveryMetrics, METRICS_VERSION } from "@/lib/metrics";
import { newSessionId, saveSession } from "@/lib/session-store";
import { ACK_TEXTS, playAck, prepareAcks, resetAcks, type AckHandle, type AckKind } from "@/lib/ack";
import { clampHistoryText, keepTail, stripAckEcho, stripSpeechTags } from "@/lib/speakable";
import {
  acceptSpeculation,
  countWords,
  decideListenAction,
  PAUSE_END_MS,
  shouldSpeculate,
  type ListenSnapshot,
} from "@/lib/conversation";
import { voiceForRound } from "@/lib/voices";
import { CODING_QUESTIONS, TECH_PERSONA, type CodingQuestion } from "@/lib/fixtures/technical-questions";
import { setVizMode, startMicViz, stopMicViz } from "@/lib/audio-viz";

export interface Persona {
  name: string;
  title: string;
  initials: string;
}

const HR_PERSONA: Persona = { name: "Priya Sharma", title: "HR, Meridian Corp", initials: "PS" };

/** /api/score's answer cap — the SENT answer keeps the newest tail. */
const SCORE_ANSWER_MAX_CHARS = 8000;
/** /api/score's questionId cap. */
const MAX_QUESTION_ID = 20;
/** Every ack/nudge line the interviewer can play — echo-scrub targets. */
const ALL_ACK_LINES = Object.values(ACK_TEXTS).flat();

/** Escape hatch: flip to false to disable ALL speculative pre-generation
 * (opening pre-warm + mid-answer speculation). The normal path is untouched. */
const SPECULATE = true;

/** An in-flight speculative /api/interview call plus its pre-synthesized audio.
 * Used both for the opening pre-warm (empty history, basisWords 0) and for
 * mid-answer speculation against the partial transcript. */
interface PrefetchedTurn {
  /** Word count of the partial transcript the request was based on. */
  basisWords: number;
  /** Resolves with the turn — or null on any failure/cancel (always silent). */
  turnPromise: Promise<InterviewerTurn | null>;
  /** Set once the turn resolves: ahead-of-time fetched + decoded audio. */
  prepared: PreparedSpeech | null;
  cancelled: boolean;
  cancel(): void;
}

// The interview room state machine from the plan:
// micCheck → preroll → thinking → speaking → listening → … → done
// Turn-taking is automatic: the listen policy (lib/conversation.ts) ends an
// answer after a pause, nudges a silent or thin answer, and gives up after
// prolonged silence; the only controls are "end answer now" and "leave". No
// mic toggle — a toggle would lie about the interaction model.

export type Phase =
  | "micCheck"
  | "preroll"
  | "thinking"
  | "speaking"
  | "listening"
  | "connectionLost"
  | "done";

export const SILENCE_MS = PAUSE_END_MS;

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
  /** Parallel to latencies: true when that turn's TTS fell back off the
   * primary engine chain — its number is real but polluted (report excludes). */
  fallbackFlags: boolean[];
  /** Parallel to latencies: true when that turn was served from a speculative
   * pre-generated turn (the sub-second path) — UI can badge it "instant". */
  instantFlags: boolean[];
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
  /** True while the current question is answered in the code editor. */
  codingTurn: boolean;
  codingQuestion: CodingQuestion;
  persona: Persona;
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

export function useInterviewMachine(
  candidateName: string,
  role: RolePreset,
  roundType: "hr" | "technical" = "hr",
  resume?: string,
): InterviewMachine {
  const [phase, setPhase] = useState<Phase>("micCheck");
  const [codingTurn, setCodingTurn] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [degradeReason, setDegradeReason] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [lastSentence, setLastSentence] = useState("");
  const [hearing, setHearing] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [fallbackFlags, setFallbackFlags] = useState<boolean[]>([]);
  const [instantFlags, setInstantFlags] = useState<boolean[]>([]);
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
  const ackRef = useRef<AckHandle | null>(null);
  const answerStartTRef = useRef(0);
  const answerEndTRef = useRef<number | null>(null);
  const endedRef = useRef(false);
  const startedRef = useRef(false);
  const textModeRef = useRef(false);
  /** Trace captured when STT degraded mid-answer — merged into the text-mode submit. */
  const pendingTraceRef = useRef<SttTraceEvent[]>([]);
  /** Live mic session that runs WHILE Priya speaks — barge-in + early-start capture. */
  const interruptSttRef = useRef<SttSession | null>(null);
  const ttsTurnStartRef = useRef<number | null>(null);
  /** Newest mid-answer speculation — older ones are cancelled on replacement. */
  const specRef = useRef<PrefetchedTurn | null>(null);
  /** Opening pre-warm fired during preroll (deterministic empty-history call). */
  const openingRef = useRef<PrefetchedTurn | null>(null);
  const codingActiveRef = useRef(false);
  const codingUsedRef = useRef(false);
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
  // Conversation-dynamics state, reset per listening session by watchSilence.
  const nudgeCountRef = useRef(0);
  const lastNudgeTRef = useRef<number | null>(null);

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
    specRef.current?.cancel();
    specRef.current = null;
    openingRef.current?.cancel();
    openingRef.current = null;
    stopMicViz();
    setVizMode("idle");
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
    // Text mode never accepts a speculative turn — kill any in flight so the
    // fetch and the prepared audio don't dangle.
    specRef.current?.cancel();
    specRef.current = null;
    // A network/unsupported failure means THIS BROWSER can't reach Google's
    // speech service (Brave, Arc, plain Chromium, VPNs) — flip to the
    // on-device Whisper engine and start its one-time download. Text mode
    // covers the meantime; "Try microphone again" routes via Whisper once
    // the badge says ready.
    // Session-only switch: a transient outage must not permanently flip the
    // stored preference (setSttEngine is reserved for explicit user choice).
    if ((reason === "network" || reason === "unsupported") && getSttEngine() !== "whisper") {
      setSttEngineEphemeral("whisper");
      ensureWhisperLoading();
    }
    textModeRef.current = true;
    setTextMode(true);
    setDegradeReason(reason);
  }, []);

  /** Fire a speculative /api/interview call NOW and pre-synthesize its reply
   * audio. The request body is IDENTICAL to what callInterviewer would send
   * with this history — that identity is what makes acceptance sound. Failures
   * resolve to null and are silent: the normal path is never affected. */
  const prefetchTurn = useCallback(
    (history: HistoryEntry[], basisWords: number): PrefetchedTurn => {
      const abort = new AbortController();
      const spec: PrefetchedTurn = {
        basisWords,
        turnPromise: Promise.resolve(null),
        prepared: null,
        cancelled: false,
        cancel() {
          spec.cancelled = true;
          abort.abort();
          spec.prepared?.cancel();
          spec.prepared = null;
        },
      };
      spec.turnPromise = fetch("/api/interview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role,
          roundType,
          candidateName,
          ...(resume ? { resume } : {}),
          history,
        }),
        signal: abort.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ turn: InterviewerTurn }>) : null))
        .then((d) => {
          if (!d?.turn || spec.cancelled || endedRef.current) return null;
          // Pre-synthesize from the RAW text (paralinguistic tags included),
          // exactly like the live speak() path; captions strip tags at delivery.
          spec.prepared = prepareSpeak(d.turn.text, { voice: voiceForRound(roundType) });
          return d.turn;
        })
        .catch(() => null); // speculation failures are silent by design
      return spec;
    },
    [candidateName, resume, role, roundType],
  );

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
    // Permission is granted by now — open the orb's true-amplitude mic tap,
    // and pre-generate engine-native acks so they play instantly later.
    if (!textModeRef.current) void startMicViz();
    resetAcks();
    void prepareAcks(voiceForRound(roundType));
    // Pre-warm the opening: the first interviewer call is deterministic (empty
    // history), so fire it AND synthesize its audio during preroll — the
    // greeting starts the instant the candidate clicks start.
    if (SPECULATE && !openingRef.current) {
      openingRef.current = prefetchTurn([], 0);
    }
    setPhase("preroll");
  }, [prefetchTurn, roundType]);

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
      roundType,
      codingUsed: codingUsedRef.current,
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
  }, [cleanup, role, roundType]);

  const latListRef = useRef<number[]>([]);
  const fallbackListRef = useRef<boolean[]>([]);
  const instantListRef = useRef<boolean[]>([]);
  const latenciesRef = () => latListRef.current;

  const beginListening = useCallback(() => {
    if (endedRef.current) return;
    setLastSentence("");
    setDegradePrefill("");
    pendingTraceRef.current = [];
    answerStartTRef.current = Date.now();
    setPhase("listening");
    if (codingActiveRef.current) return; // code-editor path — no mic for this answer
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
      // Over-long combined answers send the newest tail (schema cap); the
      // stored transcript stays full.
      body: JSON.stringify({ questionId: qid, question, answer: keepTail(combinedAnswer, SCORE_ANSWER_MAX_CHARS) }),
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
      // Nudge/ack lines played through the speakers can be re-transcribed at
      // the answer's edges (no echo filter on that path) — scrub them.
      const scrubbed = codingActiveRef.current ? transcript : stripAckEcho(transcript, ALL_ACK_LINES);
      const text = scrubbed.trim() || "(no answer)";
      // History entries are clamped to the schema cap so one giant pasted
      // answer can't 400 every later /api/interview call; turnsRef/answersRef
      // keep the full text for the transcript and scoring.
      historyRef.current.push({ speaker: "candidate", text: clampHistoryText(text) });
      turnsRef.current.push({
        speaker: "candidate",
        text,
        tStart: answerStartTRef.current,
        tEnd: Date.now(),
      });
      answersRef.current.push({ transcript: text, trace });
      answerEndTRef.current = endT;

      // Code answers are fenced so the scorer and the interviewer both see
      // them as code, and the session records the coding module was exercised.
      let scoringText = text;
      if (codingActiveRef.current && text !== "(no answer)") {
        codingUsedRef.current = true;
        scoringText = "```\n" + text + "\n```";
        historyRef.current[historyRef.current.length - 1].text = clampHistoryText(scoringText);
        codingActiveRef.current = false;
        setCodingTurn(false);
      }

      // Background scoring: follow-up answers concatenate onto the parent
      // question's transcript (plan: one rubric entry per questionId).
      const q = currentQuestionRef.current;
      if (q && text !== "(no answer)") {
        const combined = [combinedAnswersRef.current.get(q.id), scoringText].filter(Boolean).join(" ");
        combinedAnswersRef.current.set(q.id, combined);
        fireScoring(q.id, q.text, combined);
      }
    },
    [fireScoring],
  );

  const speakAck = useCallback(() => {
    // Engine-native cached ack, or nothing — a robotic ack is worse than
    // silence (the orb's thinking state carries the gap).
    ackRef.current = playAck();
  }, []);

  /** Deliver an interviewer turn: history/captions/phase, speak it (prepared
   * speculative audio when supplied), latency accounting, live-mic barge-in,
   * then hand off to listening / finish. Extracted from callInterviewer so the
   * speculative accepted path reuses the exact same pipeline. */
  const deliverTurn = useCallback(async (turn: InterviewerTurn, prepared: PreparedSpeech | null, fromCache: boolean) => {
    if (endedRef.current) {
      prepared?.cancel();
      return;
    }

    // Captions, history, and stored turns carry the clean text; only speak()
    // receives the raw text with Chatterbox paralinguistic tags ([chuckle] …).
    const cleanText = stripSpeechTags(turn.text);
    historyRef.current.push({ speaker: "interviewer", text: clampHistoryText(cleanText) });
    const tStart = Date.now();
    setCaption(cleanText);
    setQuestionIndex(turn.questionIndex);
    codingActiveRef.current = Boolean(turn.coding);
    setCodingTurn(Boolean(turn.coding));
    // Track which main question the next answer belongs to (scoring identity):
    // a follow-up keeps the parent question's id and text.
    // Ids clamped to /api/score's cap — deep-dive rounds can outrun it.
    if (turn.type === "question") {
      currentQuestionRef.current = {
        id: Math.min(MAX_QUESTION_ID, turn.questionIndex || (currentQuestionRef.current?.id ?? 0) + 1),
        text: cleanText,
      };
    } else if (turn.type === "followup" && currentQuestionRef.current === null) {
      currentQuestionRef.current = { id: Math.min(MAX_QUESTION_ID, Math.max(1, turn.questionIndex)), text: cleanText };
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
    if (endedRef.current) {
      prepared?.cancel();
      return;
    }

    // Prepared (speculative) audio schedules instantly; play() itself falls
    // back to live speak() when preparation failed or hasn't finished.
    const handle = prepared ? prepared.play() : speak(turn.text, { voice: voiceForRound(roundType) });
    speakRef.current = handle;
    ttsTurnStartRef.current = null;
    handle.firstSyllableAt.then((t) => {
      ttsTurnStartRef.current = t;
    });

    // Latency = student's last word → interviewer's first syllable (plan anchor).
    // A TTS fallback off the primary chain (chatterbox/elevenlabs/kokoro) still
    // records its latency, but flagged — the report can exclude polluted numbers.
    if (answerEndTRef.current !== null) {
      const endT = answerEndTRef.current;
      answerEndTRef.current = null;
      Promise.all([handle.firstSyllableAt, handle.engineUsed]).then(([t, used]) => {
        if (endedRef.current) return;
        latListRef.current = [...latListRef.current, Math.max(0, t - endT)];
        fallbackListRef.current = [
          ...fallbackListRef.current,
          used !== "chatterbox" && used !== "elevenlabs" && used !== "kokoro",
        ];
        // No special-casing: an accepted speculation records its genuinely
        // tiny answerEnd→firstSyllable number; the flag only labels it.
        instantListRef.current = [...instantListRef.current, fromCache];
        setLatencies(latListRef.current);
        setFallbackFlags(fallbackListRef.current);
        setInstantFlags(instantListRef.current);
      });
    }

    // Real-time conversation: the mic stays LIVE while Priya speaks. Sustained,
    // non-echo candidate speech cancels her mid-sentence (barge-in — she stops
    // and listens like a real interviewer); a quieter early start is captured
    // and becomes the beginning of the answer instead of being lost.
    const promo = { promoted: false };
    if (!textModeRef.current && !turn.done && !turn.coding) {
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
    turnsRef.current.push({ speaker: "interviewer", text: cleanText, tStart, tEnd: Date.now() });
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
  }, [beginListening, degradeToText, finishInterview, roundType]);

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
          roundType,
          candidateName,
          ...(resume ? { resume } : {}),
          history: historyRef.current,
        }),
      });
      if (!res.ok) {
        // 429 carries a friendly { message } (quota/slow-down) — expose it so
        // the room can render it instead of the generic connection-lost copy.
        if (res.status === 429) {
          const msg = await res
            .json()
            .then((d: { message?: unknown }) => (typeof d?.message === "string" ? d.message : null))
            .catch(() => null);
          if (msg && !endedRef.current) setError(msg);
        }
        throw new Error(`api_${res.status}`);
      }
      const data = (await res.json()) as { turn: InterviewerTurn };
      turn = data.turn;
    } catch {
      // A retried turn must not record the outage + human reaction time as
      // interviewer latency — drop the anchor for this turn.
      answerEndTRef.current = null;
      if (!endedRef.current) setPhase("connectionLost");
      return;
    }
    await deliverTurn(turn, null, false);
  }, [candidateName, deliverTurn, role, roundType, resume]);

  const endAnswer = useCallback(async () => {
    clearSilenceTimer();
    const sess = sttRef.current;
    sttRef.current = null;
    if (!sess) return;
    // Speak the ack immediately (the latency mask), then let Chrome finalize
    // buffered audio — the last words of the answer arrive AFTER stop().
    speakAck();
    const st = await sess.stopAndSettle();
    if (endedRef.current) return; // cleanup already cancelled any speculation
    // Consume the newest speculation only AFTER settle — the ticker is dead
    // (clearSilenceTimer above), so no fresher one can appear underneath us.
    const spec = specRef.current;
    specRef.current = null;
    const transcript = fullTranscript(st);
    // The FINAL transcript goes to history/answers — scoring and the LLM's
    // next call always see the truth, never the speculative partial.
    recordAnswer(transcript, st.trace, st.lastSpeechT ?? Date.now());
    if (spec && !spec.cancelled && acceptSpeculation(spec.basisWords, countWords(transcript))) {
      // The candidate barely added words after the speculative basis: the
      // cached turn is still the right reply — skip the live LLM call and play
      // the pre-decoded audio. This is the sub-second path.
      setPhase("thinking");
      setError(null);
      const turn = await spec.turnPromise;
      if (endedRef.current) {
        spec.cancel();
        return;
      }
      if (turn) {
        void deliverTurn(turn, spec.prepared, true);
        return;
      }
      // Speculative request failed silently — fall through to the normal path.
    }
    spec?.cancel();
    void callInterviewer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callInterviewer, deliverTurn, recordAnswer, speakAck]);

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

  // Voice-orb mode follows the machine phase; the level itself is fed by the
  // audio paths (mic analyser, playback taps, pseudo envelope).
  useEffect(() => {
    if (phase === "listening" && !textMode) setVizMode("user");
    else if (phase === "speaking") setVizMode("ai");
    else if (phase === "thinking") setVizMode("thinking");
    else setVizMode("idle");
  }, [phase, textMode]);

  // Assigned every render so these closures always see the CURRENT endAnswer —
  // memoized callbacks call through the ref instead of capturing directly.
  watchSilenceRef.current = (sess: SttSession) => {
    clearSilenceTimer();
    // Defensive: a speculation from a previous answer must never survive into
    // a fresh listening session (endAnswer normally consumed it already).
    specRef.current?.cancel();
    specRef.current = null;
    nudgeCountRef.current = 0;
    lastNudgeTRef.current = null;
    const listenStartT = Date.now();
    silenceTimerRef.current = setInterval(() => {
      const st = sess.getState();
      const now = Date.now();
      let msSinceLastSpeech: number | null = null;
      if (st.lastSpeechT !== null) {
        // A nudge refreshes the pause anchor: the candidate gets a full fresh
        // window to react instead of being cut off on the very next tick.
        msSinceLastSpeech = now - Math.max(st.lastSpeechT, lastNudgeTRef.current ?? 0);
      }
      const snapshot: ListenSnapshot = {
        msSinceListenStart: now - listenStartT,
        msSinceLastSpeech,
        words: countWords(fullTranscript(st)),
        nudges: nudgeCountRef.current,
      };
      const action = decideListenAction(snapshot);
      if (action === "wait") {
        // Draft-point speculation: a natural mid-answer pause (≥800ms, enough
        // words) means the answer is probably nearly done — fire the next
        // interviewer turn against the PARTIAL transcript and pre-synthesize
        // its audio. Only the newest speculation survives; endAnswer accepts
        // it only if the final transcript barely grew (lib/conversation.ts).
        if (
          SPECULATE &&
          !textModeRef.current &&
          !codingActiveRef.current &&
          shouldSpeculate(snapshot, specRef.current?.basisWords ?? null)
        ) {
          specRef.current?.cancel();
          const partial = fullTranscript(st).trim();
          // Same history the real call would send, except the answer text is
          // the partial — recordAnswer later pushes the FINAL text, so an
          // accepted turn's NEXT call still sees the truth.
          specRef.current = prefetchTurn(
            [...historyRef.current, { speaker: "candidate", text: clampHistoryText(partial) }],
            snapshot.words,
          );
        }
        return;
      }
      if (action === "end_answer" || action === "give_up") {
        // give_up: empty transcript records "(no answer)" — the existing
        // too-short path already keeps it out of scoring.
        void endAnswer();
        return;
      }
      // Nudges are EPHEMERAL vocal encouragement: spoken + captioned but never
      // pushed to historyRef or turnsRef — interview-flow readPosition finds
      // its place by text-matching questions in history, and injected nudge
      // lines would derail it. The mic stays live throughout.
      nudgeCountRef.current += 1;
      lastNudgeTRef.current = now;
      const kind: AckKind = action === "offer_rephrase" ? "rephrase" : "encourage";
      const h = playAck(kind);
      ackRef.current = h;
      setCaption(h?.text ?? ACK_TEXTS[kind][0]);
      // Re-anchor at playback end so the reaction window excludes the nudge audio.
      h?.done.then(() => {
        lastNudgeTRef.current = Date.now();
      });
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
    // Pre-warmed opening (fired during preroll): the greeting audio is already
    // fetched + decoded, so the interviewer speaks the instant of the click.
    const opening = openingRef.current;
    openingRef.current = null;
    if (opening && !opening.cancelled) {
      void (async () => {
        setPhase("thinking");
        setError(null);
        const turn = await opening.turnPromise;
        if (endedRef.current) {
          opening.cancel();
          return;
        }
        if (turn) {
          void deliverTurn(turn, opening.prepared, true);
          return;
        }
        // Pre-warm failed silently — the normal path owns retry/connectionLost.
        opening.cancel();
        void callInterviewer();
      })();
      return;
    }
    void callInterviewer();
  }, [callInterviewer, deliverTurn]);

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
    fallbackFlags,
    instantFlags,
    avgLatencyMs,
    micCheckTranscript,
    session,
    scores,
    sessionPersisted,
    codingTurn,
    codingQuestion: CODING_QUESTIONS[role],
    persona: roundType === "technical" ? TECH_PERSONA : HR_PERSONA,
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
