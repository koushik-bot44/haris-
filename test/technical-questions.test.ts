import { describe, expect, it } from "vitest";
import {
  CODING_QUESTIONS,
  CODING_QUESTIONS_BY_LANG,
  codingQuestionFor,
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
