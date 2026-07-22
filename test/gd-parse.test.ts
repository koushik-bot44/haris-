import { describe, expect, it } from "vitest";
import { parseGdTurns } from "@/lib/gd/parse";
import { GD_PERSONA_IDS } from "@/lib/gd/roster";

describe("GD turn parsing (batched debate reply hardening)", () => {
  it("parses a clean minified JSON array", () => {
    const turns = parseGdTurns('[{"personaId":"dominator","text":"Absolutely not."}]', 3);
    expect(turns).toEqual([{ personaId: "dominator", text: "Absolutely not." }]);
  });

  it("tolerates code fences and surrounding prose", () => {
    const raw = 'Sure! Here are the turns:\n```json\n[{"personaId":"data","text":"Studies show 40%."}]\n```\nHope that helps.';
    const turns = parseGdTurns(raw, 3);
    expect(turns).toEqual([{ personaId: "data", text: "Studies show 40%." }]);
  });

  it("returns null on malformed JSON and on wrong shapes", () => {
    expect(parseGdTurns("Vikram would interrupt here.", 3)).toBeNull();
    expect(parseGdTurns("[{broken", 3)).toBeNull();
    expect(parseGdTurns('[{"personaId":"dominator"}]', 3)).toBeNull();
    expect(parseGdTurns('{"personaId":"dominator","text":"not an array"}', 3)).toBeNull();
  });

  it("drops junk persona ids, including 'candidate' — the model never speaks as the human", () => {
    const raw = JSON.stringify([
      { personaId: "candidate", text: "I fully agree with myself." },
      { personaId: "narrator", text: "Meanwhile..." },
      { personaId: "fence", text: "Both sides have a point." },
    ]);
    expect(parseGdTurns(raw, 3)).toEqual([{ personaId: "fence", text: "Both sides have a point." }]);
  });

  it("returns null for an empty array and when every id is junk", () => {
    expect(parseGdTurns("[]", 3)).toBeNull();
    expect(parseGdTurns('[{"personaId":"candidate","text":"hijack"}]', 3)).toBeNull();
  });

  it("clamps an oversize batch to wantTurns", () => {
    const raw = JSON.stringify(
      GD_PERSONA_IDS.map((id) => ({ personaId: id, text: `${id} speaks.` })),
    );
    const turns = parseGdTurns(raw, 2);
    expect(turns).toHaveLength(2);
    expect(turns?.map((t) => t.personaId)).toEqual(GD_PERSONA_IDS.slice(0, 2));
  });
});
