import { z } from "zod";
import type { GdTurn } from "@/lib/types";
import { GD_PERSONA_IDS } from "@/lib/gd/roster";

// Parsing for the batched GD debate reply — pure and route-free so it unit
// tests like lib/llm/parse.ts does for the interviewer.

const PERSONA_IDS = new Set<string>(GD_PERSONA_IDS);

export const gdTurnsSchema = z.array(
  z.object({
    personaId: z.string().min(1).max(30),
    text: z.string().min(1).max(600),
  }),
);

/** Grab the first [...] block (models wrap JSON in fences/prose), validate the
 * shape, drop unknown persona ids (including "candidate" — the model never
 * speaks as the human), clamp to the requested batch size. */
export function parseGdTurns(raw: string, wantTurns: number): GdTurn[] | null {
  const text = raw.trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = gdTurnsSchema.safeParse(obj);
  if (!parsed.success) return null;
  const turns = parsed.data.filter((t) => PERSONA_IDS.has(t.personaId));
  if (turns.length === 0) return null;
  return turns.slice(0, wantTurns);
}
