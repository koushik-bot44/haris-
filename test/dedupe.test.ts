import { describe, expect, it } from "vitest";
import { alreadyAnswered, contentTerms, findRepeats, isSameQuestion } from "@/lib/interview/dedupe";

describe("semantic question memory", () => {
  it("catches a reworded repeat of an asked question", () => {
    const asked = ["Why did you choose Spring Boot for that project?"];
    expect(isSameQuestion("Could you explain why you went with Spring Boot for the project?", asked)).toBe(true);
    expect(isSameQuestion("So what made you pick Spring Boot for this project?", asked)).toBe(true);
    expect(isSameQuestion("Okay. Why did you choose Spring Boot for that project?", asked)).toBe(true);
  });

  it("does not confuse a deeper question on the same topic with the same question", () => {
    const asked = ["Why did you choose Spring Boot for that project?"];
    expect(isSameQuestion("What was the hardest bug you hit in the Spring Boot service, and how did you find it?", asked)).toBe(false);
    expect(isSameQuestion("How does Spring Boot's auto-configuration decide which beans to create?", asked)).toBe(false);
    expect(isSameQuestion("Tell me about a time your team disagreed with you.", ["Tell me about a project you built."])).toBe(false);
  });

  it("ignores the reaction and judges only the asking part", () => {
    const asked = ["That's a fair tradeoff, and honestly I'd argue the same. So where do you see yourself in five years?"];
    expect(isSameQuestion("Interesting. Where do you see yourself five years from now?", asked)).toBe(true);
    expect(isSameQuestion("That's a fair tradeoff. What's one thing you would change about the design?", asked)).toBe(false);
  });

  it("knows when the candidate already answered the follow-up", () => {
    const answers = [
      "I picked Spring Boot because we had learnt Java in college and the auto configuration saved us a lot of time.",
      "The hardest part was two students buying the same item at once; I fixed it by adding a unique check in the database so only one order can exist per listing.",
    ];
    expect(alreadyAnswered("Why did you choose Spring Boot?", answers)).not.toBeNull();
    expect(alreadyAnswered("How did you enforce that uniqueness in the database?", answers)).not.toBeNull();
    expect(alreadyAnswered("What would you change about the database schema if you rebuilt it?", answers)).toBeNull();
    expect(alreadyAnswered("How did you test it?", answers)).toBeNull(); // too generic to judge
    expect(alreadyAnswered("Tell me more about how you designed that schema?", ["I designed the REST API and the PostgreSQL schema, and it served 300 users."])).toBeNull(); // deeper, not the same
    expect(alreadyAnswered("Which part of Campus Cart did you build yourself, and what was the hardest bit?", ["I did the whole backend part of Campus Cart, the hardest bit was the payment flow."])).not.toBeNull();
  });

  it("stems and strips scaffolding", () => {
    const t = contentTerms("Could you walk me through how you designed the APIs and what the hardest bugs were?");
    expect(t.has("design")).toBe(true);
    expect(t.has("api")).toBe(true);
    expect(t.has("bug")).toBe(true);
    expect(t.has("walk")).toBe(false);
    expect(t.has("could")).toBe(false);
  });

  it("finds exact and reworded repeats across a transcript", () => {
    const r = findRepeats([
      "Tell me about a project you built.",
      "What was the hardest bug in it?",
      "Let's pin that down. Pick one real situation and walk me through exactly what you did.",
      "Which bug was the hardest one you hit in that project?",
      "Let's pin that down. Pick one real situation and walk me through exactly what you did.",
    ]);
    expect(r.exact).toEqual([[2, 4]]);
    expect(r.reworded).toEqual([[1, 3]]);
  });
});
