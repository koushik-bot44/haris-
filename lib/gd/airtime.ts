import type { GdInterjection, GdMetrics, Turn } from "@/lib/types";

// Pure GD scoring: airtime per speaker, interjection detection, and the
// coach-tone verdict. No clocks, no randomness — everything derives from the
// recorded turn timeline, so tests and the report replay the same numbers.

export const INTERJECTION_WINDOW_MS = 800;
export const BUILD_OVERLAP_THRESHOLD = 0.15;
export const AIRTIME_BAND: [number, number] = [20, 35];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Fraction of candidate tokens that also appear in the previous persona turn. */
export function buildOverlap(candidateText: string, personaText: string): number {
  const cand = tokens(candidateText);
  if (cand.length === 0) return 0;
  const prev = new Set(tokens(personaText));
  return cand.filter((t) => prev.has(t)).length / cand.length;
}

export function airtimeFromTurns(turns: Turn[], discussionStartT: number): GdMetrics {
  const personaAirtimeMs: Record<string, number> = {};
  const interjections: GdInterjection[] = [];
  let candidateAirtimeMs = 0;
  let candidateTurns = 0;
  let prevPersona: Turn | null = null;

  for (const t of turns) {
    const dur = Math.max(0, t.tEnd - t.tStart);
    if (t.speaker === "candidate") {
      candidateTurns++;
      candidateAirtimeMs += dur;
      // Interjection: the candidate began while the previous persona turn was
      // nominally still active, or within the window right after it ended.
      if (prevPersona && t.tStart <= prevPersona.tEnd + INTERJECTION_WINDOW_MS) {
        interjections.push({
          tMs: Math.max(0, t.tStart - discussionStartT),
          builtOnPrevious: buildOverlap(t.text, prevPersona.text) >= BUILD_OVERLAP_THRESHOLD,
        });
      }
    } else {
      const id = t.personaId ?? "persona";
      personaAirtimeMs[id] = (personaAirtimeMs[id] ?? 0) + dur;
      prevPersona = t;
    }
  }

  const personaTotal = Object.values(personaAirtimeMs).reduce((a, b) => a + b, 0);
  const total = personaTotal + candidateAirtimeMs;
  return {
    airtimeSharePct: total > 0 ? Math.round((candidateAirtimeMs / total) * 1000) / 10 : 0,
    interjections,
    candidateTurns,
    candidateAirtimeMs,
    personaAirtimeMs,
  };
}

function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 5 inside the ideal band; linear falloff on both sides (silence-adjacent
 * shares fall faster than domination — talking too little is the worse habit). */
export function airtimeScore(sharePct: number): number {
  const [lo, hi] = AIRTIME_BAND;
  if (sharePct >= lo && sharePct <= hi) return 5;
  if (sharePct < lo) return clamp(1, 5, 5 - (lo - sharePct) * 0.2);
  return clamp(1, 5, 5 - (sharePct - hi) * 0.08);
}

/** No interjections is neutral (spoke only in gaps); otherwise the build ratio
 * decides — interjections that build read as listening, derails read as noise. */
export function interjectionScore(m: GdMetrics): number {
  if (m.interjections.length === 0) return 3;
  const built = m.interjections.filter((i) => i.builtOnPrevious).length;
  return clamp(1, 5, 2 + 3 * (built / m.interjections.length));
}

/** Coach-tone verdict composed from data (no LLM call): one strength + one
 * priority fix, silence flagged warmly, never a list of failures. */
export function composeGdVerdict(
  m: GdMetrics,
  opts?: { micTrouble?: boolean },
): { avgScore: number | null; summary: string } {
  // A dead mic must never read as a silent candidate: when STT degraded during
  // the round and nothing of theirs was captured, the round is honestly unscored.
  if (opts?.micTrouble && m.candidateAirtimeMs === 0) {
    return {
      avgScore: null,
      summary:
        "Your microphone stopped working during this discussion, so nothing you said could be " +
        "captured — this round isn't scored. That's an equipment problem, not a performance one: " +
        "check the address-bar mic permission (Google Chrome works best) and run another round.",
    };
  }

  if (m.candidateTurns === 0) {
    return {
      avgScore: null,
      summary:
        "You listened the whole discussion without taking the floor — that happens to almost everyone " +
        "in a first GD, and it's fixable. Next time, grab the floor once in the first two minutes " +
        "(hold SPACE): one clear early point beats a perfect point never made.",
    };
  }

  const [lo, hi] = AIRTIME_BAND;
  const share = Math.round(m.airtimeSharePct * 10) / 10;
  const total = m.interjections.length;
  const built = m.interjections.filter((i) => i.builtOnPrevious).length;
  const derailed = total - built;
  const inBand = share >= lo && share <= hi;

  let strength: string;
  if (inBand) {
    strength = `you held ${share}% of the airtime — squarely in the healthy ${lo}–${hi}% band`;
  } else if (built > 0 && built >= derailed) {
    strength = `${built} of your ${total} interjection${total === 1 ? "" : "s"} built directly on the previous speaker's point — that reads as listening, not waiting to talk`;
  } else if (m.candidateTurns >= 2) {
    strength = `you took the floor ${m.candidateTurns} times without waiting to be invited`;
  } else {
    strength = `you got your voice into a loud room — that's the hardest first step`;
  }

  let fix: string;
  if (share < lo) {
    fix = `you held only ${share}% of the airtime — push toward the ${lo}–${hi}% band by taking the floor earlier and more often`;
  } else if (share > hi) {
    fix = `you held ${share}% of the airtime — a strong GD candidate also creates space; invite a quieter voice in and build on others' points`;
  } else if (derailed > built) {
    fix = `${derailed} of your ${total} interjections changed the subject instead of building on the last speaker — link your point to theirs first`;
  } else if (total === 0) {
    fix = `all your speaking came when the floor was free — practice one polite mid-flow interjection per discussion`;
  } else {
    fix = `keep the same airtime while sharpening one point with a number or example — depth is your next lever`;
  }

  const avg = 0.6 * airtimeScore(share) + 0.4 * interjectionScore(m);
  return {
    avgScore: Math.round(clamp(1, 5, avg) * 10) / 10,
    summary: `Your strength this round: ${strength}. One thing to work on before the next GD: ${fix}.`,
  };
}
