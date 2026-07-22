import type { GdPersona } from "@/lib/types";
import { GD_PERSONA_VOICES } from "../voices";
import { GD_ROSTER } from "./roster";

// The GD cast with voices attached. Voice assignments live in lib/voices.ts
// (pinned contract); everything else lives in roster.ts so the pure engine
// never drags the voice map into unit tests.

export const GD_PERSONAS: GdPersona[] = GD_ROSTER.map((p) => ({
  ...p,
  voice: GD_PERSONA_VOICES[p.id] ?? "Emily.wav",
}));

export function gdPersona(id: string): GdPersona | null {
  return GD_PERSONAS.find((p) => p.id === id) ?? null;
}
