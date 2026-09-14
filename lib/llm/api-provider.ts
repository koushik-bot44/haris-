import type { InterviewerTurn, InterviewRequest } from "@/lib/types";
import type { LLMProvider } from "@/lib/llm/provider";
import { buildPrompt, type NextTurnOpts } from "@/lib/llm/claude-cli";
import { clampTurn, deriveProgress, parseStreamedTurn, visibleStreamText } from "@/lib/llm/parse";
import { computeNextTurn, CODING_QUESTION_SLOT, QUESTIONS_PER_INTERVIEW } from "@/lib/llm/interview-flow";
import { CODING_INTRO, codingQuestionFor, codingSeedFrom } from "@/lib/fixtures/technical-questions";
import { CODING_AFTER_ANSWERS } from "@/lib/llm/interview-stages";
import {
  askedQuestionsBlock,
  extractQuestion,
  latestAnswer,
  peekAskedQuestions,
  peekRecalledFacts,
  primeCandidateMemory,
  recallBlock,
  recallQuery,
  rememberAnswer,
  rememberAskedQuestion,
  wasAlreadyAsked,
} from "@/lib/memory";
import { chatComplete, chatConfig, isReasoningModel } from "@/lib/llm/chat";
import { ProviderError, type AdaptiveLLMProvider, type GeneratedTurn, type GenerateInput } from "@/lib/llm/provider";
import { ctrlNote, MOVE_PREFIX, splitMoveLine } from "@/lib/interview/moveline";

// The production interviewer brain for EVERY cloud backend — Groq, OpenAI,
// Gemini, OpenRouter, or a self-hosted OpenAI-compatible server. Same prompt,
// same streamed @@CTRL protocol, same deterministic scaffolding and scripted
// rescue as the dev CLI provider — only the transport differs (lib/llm/chat.ts).
// PRODUCTION-SAFE: a deployed server uses it whenever a backend key is set.

/** A voice turn must land fast: past this the rescue speaks instead. */
const TURN_TIMEOUT_MS = 14_000;

/** An interviewer turn is 1-3 spoken sentences plus a short control line —
 * a tight cap keeps latency down and stays inside free-tier token budgets. */
const TURN_MAX_TOKENS = 220;

/** Appended to the prompt for the very first turn. */
const OPENING_NOTE =
  "This is the OPENING of the interview: greet them by first name, say in one clause that you are Haris, an AI interviewer running this round, " +
  "set the tone in a sentence (they can ask you anything, it is a rehearsal), and finish with ONE easy opening question — usually an invitation to " +
  "introduce themselves, or, if their resume profile is given, something specific and warm from it. Three to four sentences, natural, never a list. " +
  "Vary your wording; do not sound like a recorded announcement.";

/** Shared with the client so the spoken problem and the editor's starter can
 * never disagree — see codingSeedFrom. */
function codingSeed(req: InterviewRequest): string {
  return codingSeedFrom(req.candidateName, req.history);
}

/** The lead-in used to be one fixed sentence, so the hand-off to the editor
 * sounded identical in every interview. Same information, varied phrasing. */
const CODING_LEAD_INS = [
  CODING_INTRO,
  "Let's switch gears and get you writing something. The editor is open — talk me through your thinking in comments if you like, and submit when you're happy with it.",
  "Good — now let's see some code. Use the editor, comment as much or as little as you want, and submit when ready.",
];

function codingLeadIn(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return CODING_LEAD_INS[h % CODING_LEAD_INS.length];
}

/** Topic carry when the control line was missing: ~3 answers per topic. */
function carryQuestionIndex(turn: InterviewerTurn, answers: number): InterviewerTurn {
  // A turn that asked nothing belongs to no topic.
  if (turn.type === "reply" && !turn.asked) return turn;
  if (turn.questionIndex > 0 || turn.type === "greeting" || turn.type === "wrapup") return turn;
  const idx = Math.min(QUESTIONS_PER_INTERVIEW, Math.max(1, Math.ceil(answers / 3)));
  return { ...turn, questionIndex: idx };
}

export const apiProvider = {
  /** Reports the backend that is actually configured ("groq", "openai", …). */
  get name(): string {
    return chatConfig()?.backend ?? "api";
  },
  adaptive: true as const,
  /** Words for a turn the adaptive engine has already planned (lib/interview/orchestrator.ts). */
  async generate(input: GenerateInput): Promise<GeneratedTurn | null> {
    const cfg = chatConfig();
    if (!cfg) return null;
    const { req } = input;
    const first = req.candidateName.trim().split(/\s+/)[0] || "there";
    const opening = input.kind === "open" ? `\n${OPENING_NOTE}\nTheir first name is "${first}" — open with it.` : "";
    const forced = input.forcedMove
      ? `\nYOUR MOVE HAS BEEN DECIDED: ${JSON.stringify(input.forcedMove)}. Execute exactly that move in your own words. No ${MOVE_PREFIX} line.`
      : "";
    const prompt = `${buildPrompt(req, input.recall, { brief: input.brief, objective: input.objective, voice: req.voiceEngine })}${opening}${forced}`;
    const maxTokens = (isReasoningModel(cfg.model) ? TURN_MAX_TOKENS * 2 : TURN_MAX_TOKENS) + 60;
    const raw = await chatComplete(prompt, { signal: input.signal, maxTokens, timeoutMs: TURN_TIMEOUT_MS, temperature: input.kind === "open" ? 0.9 : 0.7 }, cfg);
    const { move, rest } = splitMoveLine(raw);
    const parsed = parseStreamedTurn(rest);
    if (!parsed) throw new ProviderError("the model reply had no usable spoken text", "malformed");
    return { text: parsed.text, move, note: ctrlNote(rest), done: parsed.done };
  },
  async nextTurn(req: InterviewRequest, opts?: NextTurnOpts): Promise<InterviewerTurn> {
    const o: NextTurnOpts = opts instanceof AbortSignal ? { signal: opts } : (opts ?? {});
    // Who this interview's long-term memory belongs to. The route supplies a
    // guest id when nobody is signed in, so unlike before this is populated on
    // every real request — memory used to be gated on a user id that is null
    // for every user of this deployment, which is why none of it ever ran.
    const subject = o.memoryKey?.trim() ?? "";
    /** Questions EARLIER SESSIONS already put to this candidate. Cache-only —
     * see the recall block below for why nothing here is ever awaited.
     *
     * "Earlier sessions" is load-bearing, not a nicety. computeNextTurn filters
     * the question bank by `avoid` BEFORE it draws, so the pool size feeds every
     * subsequent modulo. An avoid list that grows turn by turn therefore
     * re-orders the remaining questions mid-round, and readPosition — which
     * locates progress by exact-text lookup into that same set — stops
     * recognising what has already been asked. Observed when this filter was
     * missing: the scripted HR round asked three of five questions with indices
     * skipping 1→3→5 and spoke one follow-up three times, twice consecutively.
     *
     * Keeping THIS session's questions out of the current round is readPosition's
     * job, and it already does it correctly. */
    const askedBefore = (): string[] => {
      if (!subject) return [];
      const all = peekAskedQuestions(subject, req.roundType) ?? [];
      if (all.length === 0) return [];
      const spokenThisSession = req.history
        .filter((h) => h.speaker === "interviewer")
        .map((h) => extractQuestion(h.text))
        .filter(Boolean);
      if (spokenThisSession.length === 0) return all;
      return all.filter((q) => !wasAlreadyAsked(q, spokenThisSession));
    };
    /** Every question the interviewer ACTUALLY asks goes into long-term memory.
     * This is the write that did not exist: only answers were ever stored, so
     * "never ask the same question twice" had no data to work from.
     *
     * Greetings and wrap-ups are excluded (they are not the question bank, and
     * storing them would fill the store with hellos), and speculative
     * pre-fetches are excluded because most are thrown away — recording them
     * would retire questions that were never put to anybody. */
    const remember = (turn: InterviewerTurn, questionText = turn.text): InterviewerTurn => {
      const asks = turn.type === "question" || turn.type === "followup" || turn.asked === true || turn.coding === true;
      if (subject && !o.speculative && asks) {
        rememberAskedQuestion(subject, req.roundType, questionText, req.candidateName);
      }
      return turn;
    };
    // The rescue path says WHY it fired, on the server console — a broken key,
    // a decommissioned model and an unparseable reply must never all look like
    // "the AI is scripted" from the outside.
    const scripted = (why: string): InterviewerTurn => {
      console.warn(`[interview] scripted fallback — ${why}`);
      const turn = computeNextTurn(req.candidateName, req.history, req.roundType, req.role, req.profile, req.codeLanguage, {
        avoid: askedBefore(),
      });
      o.onText?.(turn.text);
      return remember({ ...turn, scripted: true });
    };
    // SESSION START, and the one moment in the round where a network round trip
    // is free: the client pre-fetches this turn during the mic check, so the
    // candidate is still saying "testing, one two" while it runs. Go and get the
    // long-term memory NOW, without awaiting it — every later turn then reads a
    // warm cache synchronously and recall never sits on the critical path of a
    // spoken turn again. Ahead of the config check on purpose: the scripted
    // fallback wants the already-asked list just as much as the model does.
    if (subject && req.history.length === 0) {
      primeCandidateMemory({ subject, roundType: req.roundType, candidateName: req.candidateName });
    }
    const cfg = chatConfig();
    if (!cfg) return scripted("no LLM API key in the server environment");
    // The opening line is written by the model too. It used to be a fixed
    // script "for instant start", but the client pre-fetches the opening
    // during the mic check, so the latency is hidden anyway — and a greeting
    // that is word-for-word identical every session is exactly what made the
    // whole interview feel canned. Scripted only if the model fails.
    if (req.history.length === 0) {
      try {
        const first = req.candidateName.trim().split(/\s+/)[0] || "there";
        const raw = await chatComplete(
          `${buildPrompt(req)}\n${OPENING_NOTE}\nTheir first name is "${first}" — open with it.`,
          { signal: o.signal, maxTokens: isReasoningModel(cfg.model) ? 400 : 200, timeoutMs: TURN_TIMEOUT_MS, temperature: 0.9 },
          cfg,
        );
        const parsed = parseStreamedTurn(raw);
        if (parsed && parsed.text.length >= 20) {
          const turn: InterviewerTurn = { ...parsed, type: "greeting", questionIndex: 0, done: false, asked: true };
          o.onText?.(turn.text);
          return turn;
        }
        return scripted("model greeting had no usable text");
      } catch (err) {
        return scripted(`greeting call failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (req.roundType === "technical") {
      const { answers } = deriveProgress(req.history);
      if (answers >= CODING_AFTER_ANSWERS) {
        const codingQ = codingQuestionFor(req.role, req.codeLanguage, codingSeed(req));
        const alreadyAsked = req.history.some((h) => h.speaker === "interviewer" && h.text.includes(codingQ.text));
        if (!alreadyAsked) {
          const turn: InterviewerTurn = {
            type: "question",
            text: `${codingLeadIn(codingSeed(req))} ${codingQ.text}`,
            questionIndex: CODING_QUESTION_SLOT,
            done: false,
            asked: true,
            coding: true,
          };
          o.onText?.(turn.text);
          // The PROBLEM is remembered, not the composed turn: the lead-in is
          // deliberately varied, so storing the whole line would make every
          // record unique and the exercise look new every time.
          return remember(turn, codingQ.text);
        }
      }
    }
    try {
      // Streamed @@CTRL protocol: accumulate deltas, re-emit the visible spoken
      // text (control line + partial tail withheld, deduped).
      let buffer = "";
      let lastEmitted = "";
      const emit = o.onText
        ? (t: string) => {
            if (t && t !== lastEmitted) {
              lastEmitted = t;
              o.onText!(t);
            }
          }
        : undefined;
      // Long-term memory: what we know about them, and what they have already
      // been asked. Read from the CACHE ONLY — never awaited.
      //
      // This used to `await recallCandidate(...)` right here, so the first turn
      // of every session paid a search before the model was even called. It is
      // primed at session start instead (see the greeting branch above); a cold
      // read here just means this one turn runs without long-term memory while
      // a background fill makes the next one work. A missing memory is a
      // slightly duller question. A blocked turn is dead air.
      let recall = "";
      if (subject) {
        const facts = peekRecalledFacts(subject, req.candidateName);
        const asked = peekAskedQuestions(subject, req.roundType);
        if (facts === null || asked === null) {
          primeCandidateMemory({
            subject,
            roundType: req.roundType,
            candidateName: req.candidateName,
            query: recallQuery(req.history),
          });
        }
        // Both blocks ride the `recall` slot buildPrompt already has, so the
        // prompt builder (another workstream's file) needs no change.
        recall = [recallBlock(facts ?? []), askedQuestionsBlock(asked ?? [])].filter(Boolean).join("\n");
        // A speculative pre-fetch works on a half-finished answer — never stored.
        const answer = latestAnswer(req.history);
        if (answer && !o.speculative) rememberAnswer(subject, req.roundType, answer, req.candidateName);
      }
      const prompt = buildPrompt(req, recall);
      const onDelta = emit
        ? (delta: string) => {
            buffer += delta;
            emit(visibleStreamText(buffer));
          }
        : undefined;
      // Reasoning-class models (gpt-oss, gpt-5, qwen3…) spend completion
      // tokens thinking first; a tight cap would cut the spoken reply off.
      const maxTokens = isReasoningModel(cfg.model) ? TURN_MAX_TOKENS * 2 : TURN_MAX_TOKENS;
      const raw = await chatComplete(
        prompt,
        { signal: o.signal, onDelta, maxTokens, timeoutMs: TURN_TIMEOUT_MS, temperature: 0.7 },
        cfg,
      );
      const parsed = parseStreamedTurn(raw);
      if (parsed) {
        const progress = deriveProgress(req.history);
        const turn = clampTurn(carryQuestionIndex(parsed, progress.answers), progress);
        emit?.(turn.text);
        return remember(turn);
      }
      return scripted("the model reply had no usable spoken text");
    } catch (err) {
      // network / 429 / timeout / bad model — the rescue keeps the interview alive
      return scripted(`${cfg.backend} call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
} satisfies AdaptiveLLMProvider;
