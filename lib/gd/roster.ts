import type { GdPersona } from "@/lib/types";

// Persona identity WITHOUT voice wiring. The voice map (lib/voices.ts) is a
// separate contract assembled in personas.ts — keeping it out of this module
// means the pure debate engine and its unit tests never import it.

export type GdPersonaBase = Omit<GdPersona, "voice">;

export const GD_ROSTER: GdPersonaBase[] = [
  {
    id: "moderator",
    name: "Anita",
    style: "opens the discussion, keeps time, invites the quiet, closes",
    hue: [200, 170, 230],
  },
  {
    id: "dominator",
    name: "Vikram",
    style: "interrupts, speaks in absolutes, hogs the floor",
    hue: [12, 350, 30],
  },
  {
    id: "data",
    name: "Meera",
    style: "quotes plausible numbers, leans on 'studies show'",
    hue: [210, 190, 250],
  },
  {
    id: "fence",
    name: "Rohan",
    style: "both-sides every point, hedges, rarely commits",
    hue: [270, 240, 290],
  },
];

export const GD_PERSONA_IDS = GD_ROSTER.map((p) => p.id);

export function personaName(id: string): string {
  return GD_ROSTER.find((p) => p.id === id)?.name ?? id;
}
