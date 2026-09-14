"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodeLanguage,
  DeliveryMetrics,
  HistoryEntry,
  InterviewerTurn,
  ResumeProfile,
  RolePreset,
  RubricEntry,
  Session,
  SttTraceEvent,
  Turn,
} from "@/lib/types";
import { composeOverall, scoringStatus } from "@/lib/rubric";
import {
  nextSttEngine,
  pickSttEngine,
  resolveSttCapabilities,
  setSttEngineEphemeral,
  startStt,
  type SttSession,
} from "@/lib/stt";
import { ensureWhisperLoading } from "@/lib/stt-whisper";
import { fullTranscript, type SttState } from "@/lib/stt-reducer";
import { getVoiceEngine, prepareSpeak, resolveVoiceEngine, speak, unlockAudio, type PreparedSpeech, type SpeakHandle, type VoiceEngine } from "@/lib/tts";
import { kokoroProgress, kokoroStatus } from "@/lib/tts-kokoro";

/** See `voiceWarmup` in the hook. */
export interface VoiceWarmup {
  engine: VoiceEngine | null;
  /** False only while the on-device model is still downloading. */
  ready: boolean;
  /** 0–100 while downloading, else null. */
  progress: number | null;
}
import { parseSseEvents } from "@/lib/stream";
import { createSpeechQueue, type SpeechQueue } from "@/lib/speech-queue";
import { SentenceStreamer } from "@/lib/sentence-split";
import { decideBargeIn, dropSelfEcho, echoOverlap, ECHO_OVERLAP_THRESHOLD } from "@/lib/barge-in";
import { aggregateMetrics, computeDeliveryMetrics, METRICS_VERSION } from "@/lib/metrics";
import { newSessionId, saveSession } from "@/lib/session-store";
import { ACK_TEXTS, playAck, prepareAcks, resetAcks, type AckHandle, type AckKind } from "@/lib/ack";
import { clampHistoryText, keepTail, stripAckEcho, stripSpeechTags } from "@/lib/speakable";
import {
  acceptSpeculation,
  countWords,
  decideListenAction,
  PAUSE_END_MS,
  pauseNeededMs,
  shouldSpeculate,
  type ListenSnapshot,
} from "@/lib/conversation";
import { voiceForRound } from "@/lib/voices";
import { codingQuestionFor, codingSeedFrom, TECH_PERSONA, type CodingQuestion } from "@/lib/fixtures/technical-questions";
import { setVizMode, startMicViz, stopMicViz } from "@/lib/audio-viz";
import { NO_ANSWER } from "@/lib/llm/parse";
import type { InterviewView, ReadinessReport } from "@/lib/interview/types";

/** What an adaptive turn carries besides the turn itself. */
interface TurnMeta {
  state?: string;
  view?: InterviewView;
  report?: ReadinessReport;
  scores?: RubricEntry[];
}

interface InterviewExtras {
  profile?: ResumeProfile;
  codeLanguage?: CodeLanguage;
  jobDescription?: string;
}

export interface Persona {
  name: string;
  title: string;
  initials: string;
}

const HR_PERSONA: Persona = { name: "Haris", title: "AI interviewer · HR round", initials: "H" };

/** Setup-page extras (pinned sessionStorage keys) read ONCE at hook init and
 * sent on EVERY /api/interview body — live, speculative, and opening — so the
 * interviewer brain knows the candidate. Any parse failure means absent. */
function readInterviewExtras(): InterviewExtras {
  if (typeof window === "undefined") return {};
  const extras: InterviewExtras = {};
  try {
    const jd = window.sessionStorage.getItem("pds_job_description");
    if (jd?.trim()) extras.jobDescription = jd.trim().slice(0, 4000);
  } catch {}
  try {
    const raw = window.sessionStorage.getItem("pds_resume_profile");
    if (raw) extras.profile = JSON.parse(raw) as ResumeProfile;
  } catch {}
  try {
    const lang = window.sessionStorage.getItem("pds_code_lang");
    if (lang === "java" || lang === "python" || lang === "cpp" || lang === "javascript" || lang === "c") {
      extras.codeLanguage = lang;
    }
  } catch {}
  return extras;
}

/** The room's own barge-in preference, remembered for the visit. */
const BARGE_IN_KEY = "pds_barge_in_room";

/** A refresh used to restart the whole interview from the greeting: history
 * lived in memory only. The room now keeps its progress for the tab, and a
 * reload resumes where it left off — the pending question is spoken again,
 * nothing is asked twice, and the signed server state travels with it. */
const RESUME_KEY = "pds_room_resume";
const RESUME_MAX_AGE_MS = 2 * 60 * 60 * 1000;

interface ResumeRecord {
  key: string;
  at: number;
  history: HistoryEntry[];
  turns: Turn[];
  state: string | null;
  questionIndex: number;
  codingUsed: boolean;
}

function readResume(key: string): ResumeRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as ResumeRecord;
    if (rec.key !== key || Date.now() - rec.at > RESUME_MAX_AGE_MS || !Array.isArray(rec.history) || rec.history.length === 0) return null;
    return rec;
  } catch {
    return null;
  }
}

function writeResume(rec: ResumeRecord): void {
  try {
    window.sessionStorage.setItem(RESUME_KEY, JSON.stringify(rec));
  } catch {}
}

function clearResume(): void {
  try {
    window.sessionStorage.removeItem(RESUME_KEY);
  } catch {}
}

/** May the candidate interrupt the interviewer? ON by default.
 *
 * A real interview is interruptible. Waiting out every question with a dead mic
 * was the most artificial thing this room did, and it cost more than realism:
 * with the mic closed until she finished, the first words of an answer that
 * started a beat early were simply never captured. What makes ON safe on
 * speakers is not optimism — it is the five echo defenses in lib/barge-in.ts
 * plus the echo cancellation the capture stream already asks for.
 *
 * The setup screen's older `pds_barge_in` flag is deliberately NOT consulted:
 * that checkbox starts unchecked and is written on every start, so a stored "0"
 * cannot tell "left alone" apart from "deliberately turned off" — honouring it
 * would pin every candidate to the old behaviour forever. The opt-out that
 * counts is the room's own toggle below, which is only ever written when the
 * candidate actually flips it. */
function readBargeIn(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.sessionStorage.getItem(BARGE_IN_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeBargeIn(on: boolean): void {
  try {
    window.sessionStorage.setItem(BARGE_IN_KEY, on ? "on" : "off");
  } catch {}
}

/** A streamed turn's voice already in flight (sentence pipelining): the queue
 * speaking the sentences the model has closed so far, and the streamer that
 * knows exactly which text those were. */
interface LiveSpeech {
  queue: SpeechQueue;
  streamer: SentenceStreamer;
}

/** /api/score's answer cap — the SENT answer keeps the newest tail. */
const SCORE_ANSWER_MAX_CHARS = 8000;
/** /api/score's questionId cap. */
const MAX_QUESTION_ID = 20;
/** Every ack/nudge line the interviewer can play — echo-scrub targets. */
const ALL_ACK_LINES = Object.values(ACK_TEXTS).flat();

/** Escape hatch: flip to false to disable ALL speculative pre-generation
 * (opening pre-warm + mid-answer speculation). The normal path is untouched. */
const SPECULATE = true;
/** Speculative LLM calls per answer. Each is a full interviewer turn that is
 * usually thrown away; two covers "one natural pause, then the real end". */
const MAX_SPECULATIONS_PER_ANSWER = 2;
/** Energy heard but no words yet: a batch transcriber (Whisper / cloud) is
 * still working — hold this long before treating it as noise. */
const TRANSCRIPT_LAG_GRACE_MS = 4000;
/** Longest the mic check will wait on the engine probe before starting anyway. */
const CAPABILITY_WAIT_MS = 1200;
/** How long after the mic becomes the candidate's a newly transcribed segment
 * is still treated as possibly HER voice. A batch transcriber returns a segment
 * a few hundred ms after it was cut, so her tail can land just inside the
 * answer; nothing the candidate says can get there that fast (they must speak,
 * the VAD must cut on silence, and the audio must round-trip), so the window
 * only ever collects echo candidates — and the overlap test still keeps every
 * word that turns out to be theirs. */
const ECHO_TAIL_GRACE_MS = 900;
/** A dropped connection retries on its own this many times before the room
 * waits for the candidate's click. */
const MAX_AUTO_RETRIES = 2;

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
  /** State, view and report that came with the turn — adopted only if the turn is used. */
  meta: TurnMeta | null;
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
  /** Live coverage of the interview plan (adaptive rounds). */
  view: InterviewView | null;
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
  /** False when the error is a spent daily quota — retrying cannot help. */
  retryable: boolean;
  /** The round this machine is running. */
  roundType: "hr" | "technical";
  /** True while the current question is answered in the code editor. */
  codingTurn: boolean;
  codingQuestion: CodingQuestion;
  persona: Persona;
  /** Whether the candidate may interrupt the interviewer mid-sentence (default on). */
  bargeIn: boolean;
  /** True when this tab holds an unfinished round that Start will continue. */
  resuming: boolean;
  /** Forget the unfinished round (leaving the room deliberately). */
  discardResume: () => void;
  /** Opt out (or back in) from the preroll screen; remembered for the visit. */
  setBargeIn: (on: boolean) => void;
  /** Whether the chosen voice can speak yet — the preroll holds Start on it. */
  voiceWarmup: VoiceWarmup;
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
  const [errorKind, setErrorKind] = useState<"quota" | "throttle" | null>(null);
  const [bargeIn, setBargeInState] = useState<boolean>(readBargeIn);
  const resumeKey = `${candidateName}|${role}|${roundType}`;
  const resumeRef = useRef<ResumeRecord | null | undefined>(undefined);
  if (resumeRef.current === undefined) resumeRef.current = readResume(resumeKey);
  const [resuming, setResuming] = useState<boolean>(() => resumeRef.current !== null && resumeRef.current !== undefined);
  const questionIndexRef = useRef(0);
  const persistRef = useRef<() => void>(() => {});
  const discardResume = useCallback(() => {
    resumeRef.current = null;
    setResuming(false);
    clearResume();
  }, []);
  /** The voice the session settled on and whether it can speak yet. Only the
   * on-device engine has a warm-up (a one-time model download); the preroll
   * holds the Start button until it is ready, because a greeting spoken by the
   * system voice while Kokoro was still arriving is exactly the "two voices"
   * a first-time visitor used to hear (measured: 50 s of download, greeting
   * and the whole second turn robotic, then a different voice). */
  const [voiceWarmup, setVoiceWarmup] = useState<VoiceWarmup>({ engine: null, ready: false, progress: null });
  /** True once resolveVoiceEngine() has answered for this visit. Until then
   * the engine is UNKNOWN, and unknown must read as "not ready": the preroll
   * renders synchronously while the probe is still in flight, and a Start
   * clicked in that window (a scripted browser managed it in 560 ms) started
   * the round on a voice that had not been chosen yet — greeting robotic,
   * everything after it Kokoro. */
  const voiceResolvedRef = useRef(false);

  const historyRef = useRef<HistoryEntry[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  const answersRef = useRef<AnswerRecord[]>([]);
  const sttRef = useRef<SttSession | null>(null);
  const micCheckSttRef = useRef<SttSession | null>(null);
  /** Mic check waiting on the engine probe — a second click must not open two. */
  const micCheckStartingRef = useRef(false);
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
  /** In-flight streaming interviewer fetch — cleanup aborts the SSE reader. */
  const streamAbortRef = useRef<AbortController | null>(null);
  /** Setup-page extras, read once (identical on every request this session). */
  const extrasRef = useRef<InterviewExtras | null>(null);
  /** Signed adaptive-interview state from the last turn actually used — sent back on every request. */
  const stateTokenRef = useRef<string | null>(null);
  const reportRef = useRef<ReadinessReport | null>(null);
  /** Rubric entries computed on the server from verified state (adaptive rounds). */
  const serverScoresRef = useRef<RubricEntry[] | null>(null);
  const autoRetriesRef = useRef(0);
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callInterviewerRef = useRef<() => Promise<void>>(async () => {});
  const [view, setView] = useState<InterviewView | null>(null);
  const adoptMeta = (d: TurnMeta | null | undefined) => {
    if (!d) return;
    if (typeof d.state === "string") stateTokenRef.current = d.state;
    if (d.view) setView(d.view);
    if (d.report) reportRef.current = d.report;
    if (Array.isArray(d.scores)) {
      serverScoresRef.current = d.scores;
      setScores(d.scores);
    }
  };
  if (extrasRef.current === null) extrasRef.current = readInterviewExtras();
  /** Barge-in as the long-lived callbacks see it (deliverTurn is memoized). */
  const bargeInRef = useRef(bargeIn);
  bargeInRef.current = bargeIn;
  /** Transcript rescued from an engine that died mid-answer and re-opened on
   * the fallback engine — prepended to whatever the new session hears. */
  const seedTextRef = useRef("");
  /** One silent engine swap per round (see handleListenDegrade). */
  const engineSwappedRef = useRef(false);
  /** Set when a live-mic session becomes the answer recorder: how many
   * transcript segments it already held, the text she was speaking while they
   * were heard, and how long her still-in-transit tail may keep joining that
   * window. Everything inside it is echo-checked. */
  const adoptedEchoRef = useRef<{ finals: number; echoRef: string; tailUntil: number } | null>(null);
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
  /** Scoring requests that failed outright — distinguishes "unscorable" from
   * "the scoring service was down" on the report. */
  const scoreFailuresRef = useRef(0);
  const pendingScoresRef = useRef<Promise<void>[]>([]);
  /** Speculative calls fired for the CURRENT answer (capped). */
  const specCountRef = useRef(0);
  /** The interviewer line on screen before a nudge replaced it. */
  const lastQuestionCaptionRef = useRef("");
  /** The caption as currently rendered, readable from the silence ticker
   * (an interval closure cannot see state). Captions follow the VOICE now, so
   * after a barge-in the screen holds only the draw she actually spoke — the
   * nudge must put THAT back, not the full turn text she never finished. */
  const captionRef = useRef("");
  captionRef.current = caption;
  const [scores, setScores] = useState<RubricEntry[]>([]);
  // Fresh-closure helpers assigned every render (see bottom of hook) so memoized
  // callbacks never capture a stale endAnswer — the exact bug class the
  // adversarial review confirmed in this file.
  const watchSilenceRef = useRef<(sess: SttSession) => void>(() => {});
  const adoptSessionRef = useRef<(sess: SttSession) => void>(() => {});
  const beginListeningRef = useRef<(seed?: string) => void>(() => {});
  const handleListenDegradeRef = useRef<(reason: string) => void>(() => {});
  // Conversation-dynamics state, reset per listening session by watchSilence.
  const nudgeCountRef = useRef(0);
  const lastNudgeTRef = useRef<number | null>(null);

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const setBargeIn = useCallback((on: boolean) => {
    writeBargeIn(on);
    setBargeInState(on);
  }, []);

  // Poll the warm-up while the candidate is in the mic check / preroll — the
  // only time it can gate anything. A failed model unblocks too: the system
  // voice is then the honest engine for the whole round, not a surprise later.
  useEffect(() => {
    if (phase !== "micCheck" && phase !== "preroll") return;
    const tick = () => {
      const engine = getVoiceEngine();
      const status = kokoroStatus();
      const ready = voiceResolvedRef.current && (engine !== "kokoro" || status === "ready" || status === "failed");
      setVoiceWarmup((v) => {
        const progress = engine === "kokoro" && !ready ? kokoroProgress() : null;
        return v.engine === engine && v.ready === ready && v.progress === progress ? v : { engine, ready, progress };
      });
    };
    tick();
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [phase]);

  // ——— what the CANDIDATE said ———
  //
  // With the mic live through her question, the raw transcript can start with
  // HER words: the recognizer hears the speakers, and a session adopted at the
  // end of a turn carries whatever it picked up meanwhile. Every consumer —
  // word counts, the endpointing decision, the speculative basis, the recorded
  // answer — reads the transcript through these, never raw. The echo window
  // closes at adoption (dropSelfEcho): a candidate who repeats the question's
  // words while answering it keeps every one of them.

  const candidateFinals = (st: SttState): string[] => {
    const a = adoptedEchoRef.current;
    return a ? dropSelfEcho(st.finalSegments, a.echoRef, a.finals) : st.finalSegments;
  };

  /** Let her still-in-transit tail into the echo window (see ECHO_TAIL_GRACE_MS).
   * Called from the adopted session's own update callback, so a late segment is
   * caught the instant it is promoted rather than a poll later. */
  const extendEchoWindow = (st: SttState) => {
    const a = adoptedEchoRef.current;
    if (!a || Date.now() > a.tailUntil) return;
    if (st.finalSegments.length > a.finals) {
      adoptedEchoRef.current = { ...a, finals: st.finalSegments.length };
    }
  };

  const candidateText = (st: SttState): string => {
    const a = adoptedEchoRef.current;
    // The unfinalized fragment gets the same treatment while it is still the
    // one that was in flight at adoption — after that, a new final has been
    // promoted and the window (which covers that slot) has taken over.
    const interim =
      a && st.finalSegments.length < a.finals && echoOverlap(st.interim, a.echoRef) >= ECHO_OVERLAP_THRESHOLD
        ? ""
        : st.interim;
    const raw = [...candidateFinals(st), interim].join(" ").replace(/\s+/g, " ").trim();
    // Nudge/ack lines played through the speakers land at the answer's edges
    // with no echo filter of their own — scrub them too.
    return stripAckEcho(raw, ALL_ACK_LINES).trim();
  };

  /** Point the NEXT voice attempt at a different engine after `reason` killed
   * the current one; false when nothing else could do better. Session-only
   * (setSttEngineEphemeral): one flaky moment must never rewrite the stored
   * preference. Routing a cloud outage back to the cloud would loop, so the
   * engine that just failed is excluded by construction. */
  const armFallbackEngine = useCallback((reason: string): boolean => {
    // Not failures of the engine: the user chose text, or the MIC itself is
    // denied — no other engine can hear through a blocked microphone.
    if (reason === "user_choice" || reason === "not-allowed" || reason === "service-not-allowed" || reason === "audio-capture") {
      return false;
    }
    const failed = pickSttEngine();
    const next = nextSttEngine(failed);
    if (!next || next === failed) return false;
    setSttEngineEphemeral(next);
    if (next === "whisper") ensureWhisperLoading();
    return true;
  }, []);

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
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    if (autoRetryTimerRef.current) clearTimeout(autoRetryTimerRef.current);
    autoRetryTimerRef.current = null;
    stopMicViz();
    setVizMode("idle");
  }, []);

  // StrictMode runs mount → cleanup → mount in dev. The refs survive that
  // simulated remount, so the flags MUST be re-armed in the effect setup or
  // the machine is permanently dead before the user clicks anything.
  useEffect(() => {
    endedRef.current = false;
    startedRef.current = false;
    // Asked for at mount, not at "Enable microphone": the engine the room will
    // use depends on this answer, and the mic check must exercise the SAME
    // engine the interview does — a check that passes on Chrome's recognizer
    // proves nothing about the Whisper path that will actually run. Cached for
    // the visit, so this is one GET.
    void resolveSttCapabilities();
    return cleanup;
  }, [cleanup]);

  const degradeToText = useCallback((reason: string) => {
    // Text mode never accepts a speculative turn — kill any in flight so the
    // fetch and the prepared audio don't dangle.
    specRef.current?.cancel();
    specRef.current = null;
    // Text mode covers the meantime; "Try microphone again" routes via whatever
    // engine this arms, so the retry is never the engine that just failed.
    armFallbackEngine(reason);
    textModeRef.current = true;
    setTextMode(true);
    setDegradeReason(reason);
  }, [armFallbackEngine]);

  /** ONE body shape for every interviewer request — live, speculative, and
   * opening — including the resume profile + code language extras. That
   * identity is what makes speculation acceptance sound. */
  const requestBody = useCallback(
    (history: HistoryEntry[], stream: boolean, speculative = false) =>
      JSON.stringify({
        role,
        roundType,
        candidateName,
        ...(resume ? { resume } : {}),
        // bargeIn is a client-only preference — never sent to the interviewer.
        ...(extrasRef.current?.profile ? { profile: extrasRef.current.profile } : {}),
        ...(extrasRef.current?.codeLanguage ? { codeLanguage: extrasRef.current.codeLanguage } : {}),
        ...(extrasRef.current?.jobDescription ? { jobDescription: extrasRef.current.jobDescription } : {}),
        ...(stateTokenRef.current ? { state: stateTokenRef.current } : {}),
        // Which voice will speak the reply, so the server keeps expressions the
        // engine can actually pronounce.
        ...(typeof window !== "undefined" ? { voiceEngine: getVoiceEngine() } : {}),
        history,
        ...(stream ? { stream: true } : {}),
        // A pre-fetch against a partial answer: the server never commits it
        // to long-term memory.
        ...(speculative ? { speculative: true } : {}),
      }),
    [candidateName, resume, role, roundType],
  );

  /** Fire a speculative /api/interview call NOW and pre-synthesize its reply
   * audio. The request body is IDENTICAL to what callInterviewer would send
   * with this history — that identity is what makes acceptance sound. Failures
   * resolve to null and are silent: the normal path is never affected.
   * Speculation stays NON-stream on purpose: it runs in the background, so
   * time-to-first-token buys nothing and the JSON path is the simple one. */
  const prefetchTurn = useCallback(
    (history: HistoryEntry[], basisWords: number): PrefetchedTurn => {
      const abort = new AbortController();
      const spec: PrefetchedTurn = {
        basisWords,
        turnPromise: Promise.resolve(null),
        prepared: null,
        meta: null,
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
        body: requestBody(history, false, true),
        signal: abort.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ turn: InterviewerTurn } & TurnMeta>) : null))
        .then((d) => {
          if (!d?.turn || spec.cancelled || endedRef.current) return null;
          spec.meta = d;
          // Pre-synthesize ONLY the opening greeting (basisWords 0 = one request
          // during preroll). Mid-answer speculation must NOT pre-synthesize:
          // the single local Chatterbox server can't take several concurrent
          // synthesis requests — they pile up, some fail, and a failure is what
          // dropped the voice to the robotic system fallback. Mid-answer specs
          // pre-fetch only the (cheap, cloud) question text; the audio is
          // synthesized live once, at endAnswer.
          if (basisWords === 0) {
            spec.prepared = prepareSpeak(d.turn.text, { voice: voiceForRound(roundType) });
          }
          return d.turn;
        })
        .catch(() => null); // speculation failures are silent by design
      return spec;
    },
    [requestBody, roundType],
  );

  // ——— mic check ———

  const beginMicCheck = useCallback(() => {
    if (micCheckSttRef.current || micCheckStartingRef.current) return;
    micCheckStartingRef.current = true;
    // The click is the user gesture that unlocks audio output; use it.
    unlockAudio();
    // Settle the engine choice first (mount already fired the probe, so this
    // resolves immediately in practice); the timeout only covers a server that
    // never answers, where the browser engines take over anyway.
    void Promise.race([
      resolveSttCapabilities(),
      new Promise((r) => setTimeout(r, CAPABILITY_WAIT_MS)),
    ]).then(() => {
      micCheckStartingRef.current = false;
      if (endedRef.current || micCheckSttRef.current) return;
      micCheckSttRef.current = startStt({
        onUpdate: (s: SttState) => {
          setMicCheckTranscript(fullTranscript(s));
          setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
        },
        onDegrade: (reason) => {
          micCheckSttRef.current = null;
          degradeToText(reason);
        },
      });
    });
  }, [degradeToText]);

  const confirmMicCheck = useCallback(() => {
    try {
      micCheckSttRef.current?.stop();
    } catch {}
    micCheckSttRef.current = null;
    // The click is a user gesture: unlock audio output now so the greeting
    // can play the instant "Start" is pressed (autoplay policy).
    unlockAudio();
    // Permission is granted by now — open the orb's true-amplitude mic tap.
    if (!textModeRef.current) void startMicViz();
    resetAcks();
    // Ask the server which voice/speech engines exist (cloud key? local studio
    // server?) and settle on the best one BEFORE anything is synthesized —
    // then pre-generate engine-native acks and pre-warm the opening line so
    // the greeting starts the instant the candidate clicks start.
    void resolveSttCapabilities();
    void resolveVoiceEngine().then(() => {
      voiceResolvedRef.current = true; // the preroll's Start may now judge readiness
      if (endedRef.current) return;
      void prepareAcks(voiceForRound(roundType));
      // No opening pre-fetch when resuming: the round continues from its history.
      if (SPECULATE && !openingRef.current && !resumeRef.current) {
        openingRef.current = prefetchTurn([], 0);
      }
    });
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
    // Mid-answer: the words rescued when the engine died (the textarea's
    // prefill) belong to THIS answer. Re-opening the mic with no seed threw
    // them away — the candidate spoke for a minute, saw it land in the box,
    // clicked "Try voice again", and the recorded answer started from the
    // words they said next. The rescued trace is gone by now (beginListening
    // clears it), but the text is what scoring and the next question read.
    if (phase === "listening") beginListening(degradePrefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, degradePrefill]);

  const switchToTextMode = useCallback(() => {
    try {
      micCheckSttRef.current?.stop();
    } catch {}
    micCheckSttRef.current = null;
    if (phase === "listening" && sttRef.current) {
      // Same rescue as onDegrade: what was already spoken prefills the textarea
      // — her echoed question scrubbed out of it, exactly as when the answer is
      // recorded normally.
      clearSilenceTimer();
      const captured = sttRef.current.stop();
      sttRef.current = null;
      setDegradePrefill([seedTextRef.current, candidateText(captured)].filter(Boolean).join(" ").trim());
      seedTextRef.current = "";
      pendingTraceRef.current = [...pendingTraceRef.current, ...captured.trace];
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
    // Adaptive rounds are scored on the server from verified state; the per-answer
    // /api/score path remains for a server that does not send scores.
    const scoredEntries = (serverScoresRef.current?.length ? [...serverScoresRef.current] : [...scoresRef.current.values()]).sort((a, b) => a.questionId - b.questionId);
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
      scoring: scoringStatus(scoredEntries.length, tooShortRef.current.size, scoreFailuresRef.current),
      ...(reportRef.current ? { readiness: reportRef.current } : {}),
    };
    clearResume();
    const { persisted } = saveSession(s);
    setSessionPersisted(persisted);
    setSession(s);
    setPhase("done");
  }, [cleanup, role, roundType]);

  const latListRef = useRef<number[]>([]);
  const fallbackListRef = useRef<boolean[]>([]);
  const instantListRef = useRef<boolean[]>([]);
  const latenciesRef = () => latListRef.current;

  /** Open the mic for a fresh answer. `seed` is transcript rescued from an
   * engine that just died mid-answer — it belongs to THIS answer and is
   * prepended when the answer is recorded. */
  const beginListening = useCallback((seed = "") => {
    if (endedRef.current) return;
    setLastSentence("");
    setDegradePrefill("");
    pendingTraceRef.current = [];
    seedTextRef.current = seed;
    adoptedEchoRef.current = null; // a fresh mic never heard her question
    answerStartTRef.current = Date.now();
    setPhase("listening");
    if (codingActiveRef.current) return; // code-editor path — no mic for this answer
    if (textModeRef.current) return; // textarea path — page renders the input

    // Identity guard: a session that dies AFTER a newer one replaced it must
    // not null out (and orphan) the live one.
    const mine: { sess: SttSession | null; superseded: boolean } = { sess: null, superseded: false };
    const sess = startStt({
      onUpdate: (s: SttState) => {
        const finals = candidateFinals(s);
        setLastSentence(finals[finals.length - 1] ?? "");
        setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
      },
      onDegrade: (reason) => {
        // An engine can degrade SYNCHRONOUSLY inside startStt (an unsupported
        // recognizer, a start() that throws), and the rescue path re-enters
        // this function on the fallback engine before startStt has even
        // returned. Marking the attempt dead is what stops the assignments
        // below from overwriting the session that replaced it.
        mine.superseded = true;
        if (mine.sess && sttRef.current !== mine.sess) return;
        handleListenDegradeRef.current(reason);
      },
    });
    if (mine.superseded) return; // a newer attempt already owns sttRef
    sttRef.current = sess;
    mine.sess = sess;
    if (!sess) return;
    watchSilenceRef.current(sess);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  beginListeningRef.current = beginListening;

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
      .then((r) => {
        if (r.ok) return r.json();
        scoreFailuresRef.current++;
        return null;
      })
      .then((d: { entry?: RubricEntry; tooShort?: boolean } | null) => {
        if (!d || scoreSeqRef.current.get(qid) !== seq) return; // stale response
        if (d.tooShort) tooShortRef.current.add(qid);
        else if (d.entry) {
          tooShortRef.current.delete(qid);
          scoresRef.current.set(qid, d.entry);
        }
        setScores([...scoresRef.current.values()].sort((a, b) => a.questionId - b.questionId));
      })
      .catch(() => {
        scoreFailuresRef.current++; // scoring is best-effort; the round never depends on it
      });
    pendingScoresRef.current.push(p);
  }, []);

  const recordAnswer = useCallback(
    (transcript: string, trace: SttTraceEvent[], endT: number) => {
      // Nudge/ack lines played through the speakers can be re-transcribed at
      // the answer's edges (no echo filter on that path) — scrub them.
      const scrubbed = codingActiveRef.current ? transcript : stripAckEcho(transcript, ALL_ACK_LINES);
      const text = scrubbed.trim() || NO_ANSWER;
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
      if (codingActiveRef.current && text !== NO_ANSWER) {
        codingUsedRef.current = true;
        scoringText = "```\n" + text + "\n```";
        historyRef.current[historyRef.current.length - 1].text = clampHistoryText(scoringText);
        codingActiveRef.current = false;
        setCodingTurn(false);
      }

      // Background scoring: follow-up answers concatenate onto the parent
      // question's transcript (plan: one rubric entry per questionId).
      const q = currentQuestionRef.current;
      if (q && text !== NO_ANSWER && !stateTokenRef.current) {
        const combined = [combinedAnswersRef.current.get(q.id), scoringText].filter(Boolean).join(" ");
        combinedAnswersRef.current.set(q.id, combined);
        fireScoring(q.id, q.text, combined);
      }
      persistRef.current();
    },
    [fireScoring],
  );

  const speakAck = useCallback(() => {
    // Engine-native cached ack, or nothing — a robotic ack is worse than
    // silence (the orb's thinking state carries the gap). Cancel-before-assign:
    // an overlapping ack (nudge still playing) is the two-voices bug.
    ackRef.current?.cancel();
    ackRef.current = playAck();
  }, []);

  /** Deliver an interviewer turn: history/captions/phase, speak it (prepared
   * speculative audio when supplied), latency accounting, live-mic barge-in,
   * then hand off to listening / finish. Extracted from callInterviewer so the
   * speculative accepted path reuses the exact same pipeline. `live` = a
   * streamed turn's first sentence ALREADY speaking (voice pipelining) — the
   * remainder chains after it under one composite handle. */
  const deliverTurn = useCallback(async (
    turn: InterviewerTurn,
    prepared: PreparedSpeech | null,
    fromCache: boolean,
    live?: LiveSpeech | null,
  ) => {
    if (endedRef.current) {
      prepared?.cancel();
      live?.queue.cancel();
      return;
    }

    // Captions, history, and stored turns carry the clean text; only speak()
    // receives the raw text with Chatterbox paralinguistic tags ([chuckle] …).
    const cleanText = stripSpeechTags(turn.text);
    historyRef.current.push({ speaker: "interviewer", text: clampHistoryText(cleanText) });
    const tStart = Date.now();
    // CAPTIONS FOLLOW THE VOICE, never the token stream.
    //
    // The model finishes writing a turn seconds before the voice finishes
    // saying it, so putting the text on screen as it generates meant the
    // candidate had read the whole question before the interviewer had spoken a
    // word. That reads as "the voice is lagging" even when the audio is on
    // time, and it removes any reason to listen. A streamed turn is captioned
    // draw by draw by the speech queue (see onSpeaking in streamTurn); a
    // whole-turn utterance is captioned below, when its audio actually starts.
    lastQuestionCaptionRef.current = cleanText;
    // A conversational turn — answering them, reassuring them, correcting them —
    // carries questionIndex 0 and must NOT rewind the progress display. Only a
    // turn that belongs to a topic moves it.
    // …and it never moves BACKWARDS either. The index is the model's own label
    // and it is noisy: a live round produced 5 → 4 → 5 → 3 across four turns,
    // and the scripted rescue (which cannot see the model's labels at all)
    // restarts its count from the answers it can attribute. Progress that
    // visibly rewinds reads as the interviewer losing their place; scoring
    // groups answers by this id, so a rewind would also file a new question's
    // answer under an old one.
    if (turn.questionIndex > 0) {
      questionIndexRef.current = Math.max(questionIndexRef.current, turn.questionIndex);
      setQuestionIndex((i) => Math.max(i, turn.questionIndex));
    }
    persistRef.current();
    codingActiveRef.current = Boolean(turn.coding);
    setCodingTurn(Boolean(turn.coding));
    // Track which main question the next answer belongs to (scoring identity):
    // a follow-up keeps the parent question's id and text.
    // Ids clamped to /api/score's cap — deep-dive rounds can outrun it.
    if (turn.type === "question") {
      const prevId = currentQuestionRef.current?.id ?? 0;
      currentQuestionRef.current = {
        id: Math.min(MAX_QUESTION_ID, Math.max(prevId, turn.questionIndex || prevId + 1)),
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
      live?.queue.cancel();
      return;
    }

    // Streamed-rescue consistency: the sentences already spoken must be a
    // prefix of the final turn text. If a rescue swapped the text mid-way,
    // the audio is wrong — kill it and speak the real turn in full so voice,
    // caption, history, and scoring always agree. Otherwise hand the queue
    // whatever the model wrote after the last closed sentence and close it.
    let liveSrc = live ?? null;
    if (liveSrc) {
      const { rest, mismatch } = liveSrc.streamer.flush(turn.text);
      if (mismatch) {
        liveSrc.queue.cancel();
        liveSrc = null;
      } else {
        liveSrc.queue.push(rest);
        liveSrc.queue.end();
      }
    }
    // SINGLE-VOICE INVARIANT: whatever is still speaking dies before the new
    // utterance starts — two interviewer voices at once is never acceptable,
    // no matter which orchestration path slipped.
    if (speakRef.current && speakRef.current !== liveSrc?.queue) speakRef.current.cancel();
    // One handle, three sources: a streamed turn's sentence queue (already
    // talking, cancel covers every sentence); prepared (speculative) audio
    // schedules instantly; otherwise live speak().
    const handle: SpeakHandle = liveSrc
      ? liveSrc.queue
      : prepared
        ? prepared.play()
        : speak(turn.text, { voice: voiceForRound(roundType) });
    speakRef.current = handle;
    ttsTurnStartRef.current = null;
    handle.firstSyllableAt.then((t) => {
      ttsTurnStartRef.current = t;
    });
    // Whole-turn utterance (speculative or non-streamed): one draw, so the
    // caption is the whole line and it lands with the first syllable. The
    // streamed path is already captioning itself draw by draw — writing the
    // full text here would jump ahead of the voice again. firstSyllableAt
    // always resolves, even when synthesis failed outright, so a silent
    // interviewer still shows her line rather than nothing.
    if (!liveSrc) {
      handle.firstSyllableAt.then(() => {
        if (!endedRef.current) setCaption(cleanText);
      });
    }

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

    // Real-time conversation: the mic stays LIVE while she speaks. Sustained,
    // non-echo candidate speech cancels her mid-sentence (barge-in — she stops
    // and listens like a real interviewer); a quieter early start is captured
    // and becomes the beginning of the answer instead of being lost; and when
    // she finishes uninterrupted, this same session simply CARRIES ON as the
    // answer recorder (see below) — no getUserMedia + AudioContext round-trip
    // between her last syllable and the mic being able to hear anything.
    const promo = { promoted: false };
    // The live interrupt listener, if any. Held in an object because the
    // onUpdate closure below is created before startStt returns.
    const holder: { sess: SttSession | null } = { sess: null };
    // Echo filter reference = the turn text PLUS every ack/nudge line the app
    // itself speaks — self-audio must always be filtered, never an interrupt.
    const echoRefText = `${turn.text} ${ALL_ACK_LINES.join(" ")}`;

    /** Hand this live session to the answer, recording the echo window first:
     * everything it heard up to now was heard WHILE she was speaking, so any of
     * it that overlaps her line is her voice through the speakers and must
     * never be filed as the candidate's answer. The unfinalized fragment counts
     * as one more slot — it is promoted to a segment at stop(). */
    const adoptLiveMic = (sess: SttSession) => {
      const st = sess.getState();
      adoptedEchoRef.current = {
        finals: st.finalSegments.length + (st.interim.trim() ? 1 : 0),
        echoRef: echoRefText,
        tailUntil: Date.now() + ECHO_TAIL_GRACE_MS,
      };
      promo.promoted = true;
      adoptSessionRef.current(sess);
    };

    // Barge-in is ON by default now (opt out on the preroll screen). Never on
    // the closing turn or a coding question: there is nothing to interrupt with.
    if (bargeInRef.current && !textModeRef.current && !turn.done && !turn.coding) {
      // The warm-up window guards the MIC opening (recognizer flush, speaker
      // pop, the ack's tail) as much as the voice starting. On a streamed turn
      // the voice has usually been going since before deliverTurn ran — draw 1
      // starts while the model is still writing — so measured from the first
      // syllable alone the window could already be spent the instant the mic
      // opens. Anchor on whichever happened LATER.
      const micOpenedAt = Date.now();
      holder.sess = startStt({
        onUpdate: (s: SttState) => {
          setHearing(s.lastSpeechT !== null && Date.now() - s.lastSpeechT < 900);
          if (promo.promoted) {
            extendEchoWindow(s);
            const finals = candidateFinals(s);
            setLastSentence(finals[finals.length - 1] ?? "");
            return;
          }
          const heard = fullTranscript(s);
          const now = Date.now();
          const msSince = ttsTurnStartRef.current === null ? 0 : Math.min(now - ttsTurnStartRef.current, now - micOpenedAt);
          if (
            holder.sess &&
            !endedRef.current &&
            decideBargeIn({ heardText: heard, spokenText: echoRefText, msSinceTtsStart: msSince }) === "interrupt"
          ) {
            interruptSttRef.current = null;
            handle.cancel();
            adoptLiveMic(holder.sess);
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
          // Identity guard, same as beginListening's: once adopted this
          // session is sttRef, and only while it still is may its death rescue
          // "the current answer". A late degrade after endAnswer already moved
          // on would otherwise capture a NEWER session's transcript as this
          // answer's partial and re-open a second mic under it.
          if (sttRef.current !== holder.sess) return;
          handleListenDegradeRef.current(reason);
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
        // She finished; the mic has been open the whole time. KEEP this session
        // as the answer recorder instead of stopping it and opening a new one:
        // that teardown/startup is a real gap (getUserMedia + AudioContext) and
        // it lands exactly where candidates start talking, so its cost is the
        // first words of the answer. Adoption is unconditional now — what the
        // old code was really guarding against (her voice being filed as their
        // answer) is handled properly by the echo window adoptLiveMic records,
        // which drops HER lines segment by segment instead of judging the whole
        // transcript at once and keeping every word of it when the candidate's
        // early start diluted the ratio.
        adoptLiveMic(isess);
        return;
      }
      beginListening();
    }
  }, [beginListening, finishInterview, roundType]);

  /** One streaming attempt (stream:true → SSE). The display-first pipeline:
   * text events set the caption WHILE phase is still 'thinking' — the user
   * watches the reply type out during generation — and the moment a sentence
   * closes, it is handed to the speech queue (sentence pipelining): the
   * interviewer starts talking while the model is still writing, and the next
   * sentence synthesizes while the current one plays. Phase flips to
   * 'speaking' when audio actually starts. Resolves with the final turn plus
   * the in-flight queue; throws on ANY failure with the queue already
   * cancelled (the caller falls back to one non-stream POST). */
  const streamTurn = useCallback(async (): Promise<{ turn: InterviewerTurn; live: LiveSpeech | null }> => {
    const abort = new AbortController();
    streamAbortRef.current = abort;
    const streamer = new SentenceStreamer();
    // Holder (not a bare `let`): the queue is created inside a callback, and
    // TypeScript's flow analysis would otherwise narrow it to `null` at the
    // catch below.
    const voice: { queue: SpeechQueue | null } = { queue: null };
    const onStreamText = (text: string) => {
      // No setCaption here on purpose — see the caption note in deliverTurn.
      // The reply is captioned by the speech queue as each draw starts speaking.
      const { sentences, reset } = streamer.feed(text);
      if (reset && voice.queue) {
        // The text stopped being an extension of what was spoken (a rescue
        // replaced the reply mid-stream) — restart the voice from scratch.
        voice.queue.cancel();
        voice.queue = null;
      }
      if (sentences.length === 0) return;
      if (!voice.queue) {
        // SINGLE-VOICE INVARIANT — nothing else may be talking when the reply
        // starts. The ack (if still playing) gates the first sentence instead
        // of being cut off; the queue waits for it.
        if (speakRef.current) speakRef.current.cancel();
        const q = createSpeechQueue({
          voice: voiceForRound(roundType),
          gate: ackRef.current?.done ?? null,
          // Each draw appears on screen when ITS audio starts, so the caption
          // grows at speaking pace instead of arriving all at once. Tags are
          // stripped here too: [chuckle] is an instruction to Chatterbox, never
          // something the candidate should read.
          onSpeaking: (spoken, index) => {
            if (endedRef.current) return;
            const clean = stripSpeechTags(spoken);
            if (!clean) return;
            setCaption((prev) => (index === 0 ? clean : `${prev} ${clean}`.trim()));
          },
        });
        voice.queue = q;
        speakRef.current = q;
        q.firstSyllableAt.then(() => {
          if (!endedRef.current) setPhase((p) => (p === "thinking" ? "speaking" : p));
        });
      }
      for (const s of sentences) voice.queue.push(s);
    };
    try {
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody(historyRef.current, true),
        signal: abort.signal,
      });
      if (endedRef.current) throw new Error("ended");
      if (!res.ok || !res.body) throw new Error(`stream_${res.status}`);
      // A JSON response despite stream:true (proxy stripped it, older server)
      // is still a valid turn — use it instead of burning a second LLM call.
      if (res.headers.get("content-type")?.includes("application/json")) {
        const data = (await res.json()) as { turn?: InterviewerTurn } & TurnMeta;
        if (!data?.turn) throw new Error("stream_bad_json");
        adoptMeta(data);
        return { turn: data.turn, live: null };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let turn: InterviewerTurn | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (endedRef.current) {
          void reader.cancel().catch(() => {});
          throw new Error("ended");
        }
        if (value) buf += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseEvents(buf);
        buf = rest;
        for (const ev of events) {
          if (ev.kind === "error") throw new Error(ev.error);
          if (ev.kind === "turn") {
            turn = ev.turn;
            adoptMeta(ev);
            continue;
          }
          // Display-first: the reply TYPES OUT here while she still "thinks"
          // (captions are always rendered — a11y + text-before-voice), and
          // every closed sentence goes straight to the voice.
          onStreamText(ev.text);
        }
        if (turn) {
          void reader.cancel().catch(() => {});
          break;
        }
        if (done) break;
      }
      if (!turn) throw new Error("stream_no_turn");
      // A turn without a single closed sentence yet (short reply) is spoken
      // whole by deliverTurn; otherwise the queue carries on with the tail.
      return { turn, live: voice.queue ? { queue: voice.queue, streamer } : null };
    } catch (err) {
      const q = voice.queue;
      if (q) {
        q.cancel();
        if (speakRef.current === q) speakRef.current = null;
      }
      throw err;
    } finally {
      if (streamAbortRef.current === abort) streamAbortRef.current = null;
    }
  }, [requestBody, roundType]);

  const callInterviewer = useCallback(async () => {
    if (endedRef.current) return;
    setPhase("thinking");
    setCaption(""); // last turn's line must not linger while the next streams in
    setError(null);
    setErrorKind(null);
    // Streaming-first. ANY streaming failure (error event, network, malformed)
    // falls back to exactly ONE non-stream POST — today's path below, which
    // carries the route's retry-once policy — so the interview never dies.
    // Short replies whose turn lands before the first sentence completes
    // behave exactly as before: deliverTurn speaks the full text once.
    try {
      const { turn, live } = await streamTurn();
      if (endedRef.current) {
        live?.queue.cancel();
        return;
      }
      autoRetriesRef.current = 0;
      await deliverTurn(turn, null, false, live);
      return;
    } catch {
      if (endedRef.current) return;
      setPhase("thinking"); // a cancelled first utterance may have flipped visuals
    }
    let turn: InterviewerTurn;
    let quotaSpent = false;
    try {
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody(historyRef.current, false),
      });
      if (!res.ok) {
        // 429 carries a friendly { message } (quota/slow-down) — expose it so
        // the room can render it instead of the generic connection-lost copy.
        if (res.status === 429) {
          const msg = await res
            .json()
            .then((d: { message?: unknown }) => (typeof d?.message === "string" ? d.message : null))
            .catch(() => null);
          if (msg && !endedRef.current) {
            setError(msg);
            // A spent daily quota is a dead end; a "slow down" is not.
            quotaSpent = /budget|quota|tomorrow/i.test(msg);
            setErrorKind(quotaSpent ? "quota" : "throttle");
          }
        }
        throw new Error(`api_${res.status}`);
      }
      const data = (await res.json()) as { turn: InterviewerTurn } & TurnMeta;
      turn = data.turn;
      adoptMeta(data);
    } catch {
      // A retried turn must not record the outage + human reaction time as
      // interviewer latency — drop the anchor for this turn.
      answerEndTRef.current = null;
      if (!endedRef.current) {
        setPhase("connectionLost");
        // Never leave the candidate stranded: a dropped connection retries on its
        // own, backing off; a spent quota waits for the button instead.
        if (!quotaSpent && autoRetriesRef.current < MAX_AUTO_RETRIES) {
          autoRetriesRef.current++;
          if (autoRetryTimerRef.current) clearTimeout(autoRetryTimerRef.current);
          autoRetryTimerRef.current = setTimeout(() => {
            autoRetryTimerRef.current = null;
            if (!endedRef.current) void callInterviewerRef.current();
          }, 2500 * autoRetriesRef.current);
        }
      }
      return;
    }
    autoRetriesRef.current = 0;
    await deliverTurn(turn, null, false);
  }, [deliverTurn, requestBody, streamTurn]);
  callInterviewerRef.current = callInterviewer;

  const endAnswer = useCallback(async () => {
    clearSilenceTimer();
    const sess = sttRef.current;
    sttRef.current = null;
    if (!sess) return;
    // Immediate feedback: the settle wait below (up to seconds on a batch
    // transcriber) must not look like an ignored click.
    setPhase("thinking");
    // Speak the ack immediately (the latency mask), then let Chrome finalize
    // buffered audio — the last words of the answer arrive AFTER stop().
    speakAck();
    const st = await sess.stopAndSettle();
    if (endedRef.current) return; // cleanup already cancelled any speculation
    // Consume the newest speculation only AFTER settle — the ticker is dead
    // (clearSilenceTimer above), so no fresher one can appear underneath us.
    const spec = specRef.current;
    specRef.current = null;
    // Her own question, heard through the speakers while the mic was live, is
    // dropped here — it is the one thing that must never be filed as the
    // candidate's answer. A rescued partial from an engine that died mid-answer
    // is prepended; its trace is merged so delivery metrics stay complete.
    const transcript = [seedTextRef.current, candidateText(st)].filter(Boolean).join(" ").trim();
    const trace = [...pendingTraceRef.current, ...st.trace];
    seedTextRef.current = "";
    pendingTraceRef.current = [];
    adoptedEchoRef.current = null;
    // The FINAL transcript goes to history/answers — scoring and the LLM's
    // next call always see the truth, never the speculative partial.
    recordAnswer(transcript, trace, st.lastSpeechT ?? Date.now());
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
        adoptMeta(spec.meta);
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
      seedTextRef.current = ""; // the textarea already carries whatever was rescued
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

  /** A nudge line through the normal voice — for engines with no cached
   * native ack. A caption that was never spoken reads as the interviewer
   * silently swapping the question, so the line is always audible. */
  const spokenNudge = (kind: AckKind): AckHandle => {
    const text = ACK_TEXTS[kind][0];
    const h = speak(text, { voice: voiceForRound(roundType) });
    return { done: h.done, cancel: () => h.cancel(), firstSyllableAt: h.firstSyllableAt, text };
  };

  // Assigned every render so these closures always see the CURRENT endAnswer —
  // memoized callbacks call through the ref instead of capturing directly.

  /** The answer recorder died mid-answer. Rescue what it heard, then try to
   * KEEP THE ROUND SPOKEN: one silent swap onto the next engine re-opens the
   * mic with the partial carried over, which matters far more now that the
   * default engine is a network service — a single Groq hiccup used to turn a
   * voice interview into a typing exercise. A second failure has earned text
   * mode, and the rescued words prefill the textarea as before. */
  handleListenDegradeRef.current = (reason: string) => {
    clearSilenceTimer();
    // Capture BEFORE discarding the session — 45 seconds of a spoken answer
    // must not vanish because the recognizer died.
    const captured = sttRef.current?.getState();
    sttRef.current = null;
    const partial = [seedTextRef.current, captured ? candidateText(captured) : ""]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!engineSwappedRef.current && armFallbackEngine(reason)) {
      engineSwappedRef.current = true;
      beginListeningRef.current(partial);
      // Order matters: beginListening clears the trace buffer, and the dead
      // engine's trace describes real speech this answer — endAnswer merges it.
      if (captured) pendingTraceRef.current = captured.trace;
      return;
    }
    seedTextRef.current = "";
    if (partial) setDegradePrefill(partial);
    // The trace rides along so delivery metrics still cover the spoken part.
    if (captured) pendingTraceRef.current = captured.trace;
    degradeToText(reason);
  };

  watchSilenceRef.current = (sess: SttSession) => {
    clearSilenceTimer();
    // Defensive: a speculation from a previous answer must never survive into
    // a fresh listening session (endAnswer normally consumed it already).
    specRef.current?.cancel();
    specRef.current = null;
    specCountRef.current = 0;
    nudgeCountRef.current = 0;
    lastNudgeTRef.current = null;
    const listenStartT = Date.now();
    silenceTimerRef.current = setInterval(() => {
      const st = sess.getState();
      const now = Date.now();
      // Words the CANDIDATE said: her question and her own nudge lines re-heard
      // through the speakers are scrubbed, so an echoed "Mm-hm — go on?" can
      // neither count as an answer nor end one.
      const said = candidateText(st);
      const words = countWords(said);
      let msSinceLastSpeech: number | null = null;
      if (st.lastSpeechT !== null) {
        // A nudge refreshes the pause anchor: the candidate gets a full fresh
        // window to react instead of being cut off on the very next tick.
        const anchor = Math.max(st.lastSpeechT, lastNudgeTRef.current ?? 0);
        if (words > 0) msSinceLastSpeech = now - anchor;
        // Energy heard but no words yet: a batch transcriber is still working
        // on it — hold rather than nudge into it. Past the grace window it
        // was echo or noise, and the silence policy applies.
        else if (now - anchor < TRANSCRIPT_LAG_GRACE_MS) msSinceLastSpeech = 0;
      }
      const snapshot: ListenSnapshot = {
        msSinceListenStart: now - listenStartT,
        msSinceLastSpeech,
        words,
        nudges: nudgeCountRef.current,
        // Endpointing follows the WORDS, not a stopwatch: trailing off on "and"
        // or "um" buys the candidate more room than the old flat floor gave
        // them, while a finished sentence — or an out-loud "that's it" — hands
        // the turn back sooner. That difference is most of the dead air.
        pauseNeededMs: pauseNeededMs(said),
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
          specCountRef.current < MAX_SPECULATIONS_PER_ANSWER &&
          shouldSpeculate(snapshot, specRef.current?.basisWords ?? null)
        ) {
          specRef.current?.cancel();
          const partial = said;
          // Same history the real call would send, except the answer text is
          // the partial — recordAnswer later pushes the FINAL text, so an
          // accepted turn's NEXT call still sees the truth.
          specRef.current = prefetchTurn(
            [...historyRef.current, { speaker: "candidate", text: clampHistoryText(partial) }],
            snapshot.words,
          );
          specCountRef.current++;
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
      ackRef.current?.cancel(); // never two acks at once
      const h = playAck(kind) ?? spokenNudge(kind);
      ackRef.current = h;
      // What is on screen right now is what she said; the full turn text is
      // the fallback for a caption that never landed (a silent engine).
      const questionCaption = captionRef.current || lastQuestionCaptionRef.current;
      // The nudge's caption lands with its AUDIO, like every other line. A
      // cached ack starts at once; a live one (Kokoro) took ~1.4 s to render in
      // the browser run, and the text sitting there first read as the
      // interviewer silently swapping the question before speaking.
      h.firstSyllableAt.then(() => {
        if (!endedRef.current && ackRef.current === h) setCaption(h.text);
      });
      // Re-anchor at playback end so the reaction window excludes the nudge
      // audio, and put the question back on screen.
      h.done.then(() => {
        lastNudgeTRef.current = Date.now();
        setCaption((c) => (c === h.text ? questionCaption : c));
      });
    }, 250);
  };
  adoptSessionRef.current = (sess: SttSession) => {
    setDegradePrefill("");
    pendingTraceRef.current = [];
    seedTextRef.current = "";
    setLastSentence("");
    answerStartTRef.current = Date.now();
    sttRef.current = sess;
    setPhase("listening");
    watchSilenceRef.current(sess);
  };

  const startInterview = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    // Resume an unfinished round from this tab: restore what was said and the
    // signed server state; if the candidate was mid-answer, speak the pending
    // question again rather than asking the server for a new one.
    const rec = resumeRef.current;
    if (rec) {
      resumeRef.current = null;
      setResuming(false);
      const last = rec.history[rec.history.length - 1];
      const pending = last?.speaker === "interviewer" ? last : null;
      historyRef.current = pending ? rec.history.slice(0, -1) : [...rec.history];
      const lastTurn = rec.turns[rec.turns.length - 1];
      turnsRef.current = pending && lastTurn?.speaker === "interviewer" ? rec.turns.slice(0, -1) : [...rec.turns];
      stateTokenRef.current = rec.state;
      codingUsedRef.current = rec.codingUsed;
      questionIndexRef.current = rec.questionIndex;
      setQuestionIndex(rec.questionIndex);
      if (pending) {
        const coding = /editor is open|use the editor/i.test(pending.text);
        void deliverTurn({ type: "question", text: pending.text, questionIndex: rec.questionIndex, done: false, asked: true, ...(coding ? { coding: true } : {}) }, null, false);
      } else {
        void callInterviewer();
      }
      return;
    }
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
          adoptMeta(opening.meta);
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

  persistRef.current = () => {
    if (endedRef.current || historyRef.current.length === 0) return;
    writeResume({
      key: resumeKey,
      at: Date.now(),
      history: historyRef.current,
      turns: turnsRef.current,
      state: stateTokenRef.current,
      questionIndex: questionIndexRef.current,
      codingUsed: codingUsedRef.current,
    });
  };

  const retryConnection = useCallback(() => {
    if (autoRetryTimerRef.current) {
      clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
    setError(null);
    setErrorKind(null);
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
    view,
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
    // Spoken question, editor language, and starter all follow the chosen language.
    // Seeded identically to the server so the editor always shows the starter
    // for the problem the interviewer actually spoke.
    codingQuestion: codingQuestionFor(
      role,
      extrasRef.current?.codeLanguage,
      codingSeedFrom(candidateName, historyRef.current),
    ),
    persona: roundType === "technical" ? TECH_PERSONA : HR_PERSONA,
    bargeIn,
    resuming,
    discardResume,
    setBargeIn,
    voiceWarmup,
    roundType,
    degradePrefill,
    error,
    retryable: errorKind !== "quota",
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
