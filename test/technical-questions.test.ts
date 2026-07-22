import { describe, expect, it } from "vitest";
import {
  CODING_QUESTIONS,
  CODING_QUESTIONS_BY_LANG,
  CODING_POOL,
  codingQuestionFor,
  codingSeedFrom,
} from "@/lib/fixtures/technical-questions";
import type { CodeLanguage, RolePreset } from "@/lib/types";

const ROLES: RolePreset[] = ["general", "java-sde-fresher", "frontend-fresher"];
const LANGS: CodeLanguage[] = ["java", "python", "cpp", "javascript", "c"];

// The function each role's exercise is built around — every starter must carry
// it so the candidate types into a real signature, not an empty buffer.
const FN_NAME: Record<RolePreset, RegExp> = {
  "java-sde-fresher": /first_?non_?repeating/i,
  "frontend-fresher": /debounce/i,
  general: /is_?anagram/i,
};

describe("codingQuestionFor", () => {
  it("returns a matching-language question with a non-empty starter for every role × language", () => {
    for (const role of ROLES) {
      for (const lang of LANGS) {
        const q = codingQuestionFor(role, lang);
        expect(q.language).toBe(lang);
        expect(q.text.trim().length).toBeGreaterThan(0);
        expect(q.starter.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the same problem across languages within a role: one id, same function name", () => {
    for (const role of ROLES) {
      const ids = new Set(LANGS.map((lang) => codingQuestionFor(role, lang).id));
      expect(ids.size).toBe(1);
      for (const lang of LANGS) {
        expect(codingQuestionFor(role, lang).starter).toMatch(FN_NAME[role]);
      }
    }
  });

  it("falls back to the role's default on a missing or junk language", () => {
    // Stale/absent sessionStorage must never crash the room.
    expect(codingQuestionFor("java-sde-fresher", undefined)).toEqual(CODING_QUESTIONS["java-sde-fresher"]);
    expect(codingQuestionFor("general", "rust" as CodeLanguage)).toEqual(CODING_QUESTIONS.general);
  });

  it("compat: CODING_QUESTIONS[role] is the role's pre-multi-language default", () => {
    expect(CODING_QUESTIONS["java-sde-fresher"]).toEqual(CODING_QUESTIONS_BY_LANG["java-sde-fresher"].java);
    expect(CODING_QUESTIONS["frontend-fresher"]).toEqual(CODING_QUESTIONS_BY_LANG["frontend-fresher"].javascript);
    expect(CODING_QUESTIONS.general).toEqual(CODING_QUESTIONS_BY_LANG.general.javascript);
    // The scripted flow speaks .text — the defaults keep their language names.
    expect(CODING_QUESTIONS["java-sde-fresher"].text).toContain("Java");
    expect(CODING_QUESTIONS["frontend-fresher"].text).toContain("debounce");
  });

  it("uses Monaco language ids only", () => {
    for (const role of ROLES) {
      for (const lang of LANGS) {
        expect(LANGS).toContain(CODING_QUESTIONS_BY_LANG[role][lang].language);
      }
    }
  });
});

describe("coding question variety", () => {
  const ROLES = ["general", "java-sde-fresher", "frontend-fresher"] as const;

  it("draws different problems for different sessions", () => {
    // The regression: there was exactly ONE exercise per role, so every
    // candidate on `general` met the anagram question in every session forever.
    for (const role of ROLES) {
      const seen = new Set(
        ["I built a food app", "I made a chess engine", "I work mostly on ML", "portfolio site", "a bank ledger"].map(
          (answer) => codingQuestionFor(role, "java", codingSeedFrom("Koushik", [{ speaker: "candidate", text: answer }])).id,
        ),
      );
      expect(seen.size).toBeGreaterThan(1);
    }
  });

  it("is stable within a session — the editor must not swap problems mid-round", () => {
    const history = [
      { speaker: "candidate", text: "I built a campus food ordering app" },
      { speaker: "interviewer", text: "nice" },
      { speaker: "candidate", text: "and later a chess engine" },
    ];
    const seed = codingSeedFrom("Koushik", history);
    // Seed derives from the FIRST answer, so later answers cannot change it.
    expect(seed).toBe(codingSeedFrom("Koushik", history.slice(0, 1)));
    expect(codingQuestionFor("general", "java", seed).id).toBe(codingQuestionFor("general", "java", seed).id);
  });

  it("every pooled problem exists in every language with a matching starter", () => {
    for (const role of ROLES) {
      for (const problem of CODING_POOL[role]) {
        for (const lang of LANGS) {
          expect(problem[lang].language).toBe(lang);
          expect(problem[lang].starter.length).toBeGreaterThan(20);
        }
      }
    }
  });
});
