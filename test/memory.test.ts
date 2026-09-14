import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askedQuestionsBlock,
  askedTagFor,
  containerTagFor,
  extractQuestion,
  guestCookieHeader,
  previousContainerTagFor,
  memorySubjectFor,
  newGuestId,
  peekAskedQuestions,
  peekRecalledFacts,
  primeCandidateMemory,
  questionKey,
  readGuestId,
  recallAskedQuestions,
  recallCandidate,
  rememberAskedQuestion,
  resetMemoryCaches,
  wasAlreadyAsked,
} from "@/lib/memory";

// Long-term memory. The behaviour that matters here is not "does it call an
// HTTP API" — it is the three things that made the feature dead code in
// production: nothing ever recorded a QUESTION, guests had no identity to key
// memory on, and the container tag changed out from under the stored data.
//
// fetch is stubbed throughout; the live round trip against the real Supermemory
// account was verified separately (writes come back `queued` and take ~20s to
// become searchable, and containerTags is an OR).

const KEY_ENV = "SUPERMEMORY_API_KEY";

/** A v3/search response shaped exactly like the live one. */
function searchResponse(contents: string[]) {
  return {
    ok: true,
    json: async () => ({ results: contents.map((c) => ({ score: 0.9, chunks: [{ content: c }] })) }),
  };
}

function stubFetch(impl: (url: string, init: RequestInit) => unknown) {
  const spy = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Requests the stub saw, split by endpoint. */
function calls(spy: ReturnType<typeof stubFetch>) {
  const seen = spy.mock.calls as unknown as [string, RequestInit][];
  const parse = (c: [string, RequestInit]) => JSON.parse(String(c[1].body)) as Record<string, unknown>;
  return {
    searches: seen.filter((c) => c[0].endsWith("/v3/search")).map(parse),
    writes: seen.filter((c) => c[0].endsWith("/v3/documents")).map(parse),
  };
}

beforeEach(() => {
  vi.stubEnv(KEY_ENV, "test-key");
  resetMemoryCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetMemoryCaches();
});

describe("guest identity (why memory never ran in production)", () => {
  it("mints a prefixed, validatable id and round-trips it through a cookie header", () => {
    const id = newGuestId();
    expect(id.startsWith("guest-")).toBe(true);
    const header = guestCookieHeader(id, true);
    expect(header).toContain(`pds_guest=${id}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
    // The browser sends it back in Cookie form, alongside everything else.
    expect(readGuestId(`pds_client=abc; ${header.split(";")[0]}; theme=dark`)).toBe(id);
  });

  it("omits Secure off HTTPS so a LAN deployment does not silently lose every guest", () => {
    expect(guestCookieHeader("guest-abcdefgh", false)).not.toContain("Secure");
  });

  it("refuses junk and absent cookies rather than using them as a storage key", () => {
    expect(readGuestId(null)).toBeNull();
    expect(readGuestId("")).toBeNull();
    expect(readGuestId("pds_client=abc")).toBeNull();
    expect(readGuestId("pds_guest=short")).toBeNull(); // fails the length floor
    expect(readGuestId("pds_guest=../../etc/passwd")).toBeNull();
    expect(readGuestId("pds_guest=no-prefix-1234567890")).toBeNull();
  });

  it("prefers a signed-in user id but never leaves the subject empty", () => {
    expect(memorySubjectFor("user-42", "guest-abcdefgh")).toBe("user-42");
    expect(memorySubjectFor(null, "guest-abcdefgh")).toBe("guest-abcdefgh");
    expect(memorySubjectFor("   ", "guest-abcdefgh")).toBe("guest-abcdefgh");
  });

  it("keeps every subject in its own container — no guest can read another's history", () => {
    const a = containerTagFor(memorySubjectFor(null, "guest-11111111-aaaa"));
    const b = containerTagFor(memorySubjectFor(null, "guest-22222222-bbbb"));
    const signedIn = containerTagFor(memorySubjectFor("google:900", "guest-11111111-aaaa"));
    expect(a).not.toBe(b);
    expect(a).not.toBe(signedIn);
    expect(new Set([a, b, signedIn]).size).toBe(3);
  });
});

describe("container tags — keyed by identity, never by name", () => {
  it("writes under a hashed identity tag that reveals nothing about the subject", () => {
    const tag = containerTagFor("google:900123");
    expect(tag).toMatch(/^pds_u_[a-f0-9]{32}$/);
    expect(tag).not.toContain("900123");
    expect(containerTagFor("google:900123")).toBe(tag);
  });

  it("keeps ids apart that a slug used to collapse together", () => {
    expect(containerTagFor("guest-AbCdEfGh")).not.toBe(containerTagFor("guest-abcdefgh"));
    expect(containerTagFor("user.1")).not.toBe(containerTagFor("user_1"));
  });

  it("regression: two signed-in candidates both called Rahul never share memory", async () => {
    const spy = stubFetch(() => searchResponse([]));
    await recallCandidate("507f1f77bcf86cd799439011", "background", { candidateName: "Rahul" });
    await recallCandidate("507f191e810c19729de860ea", "background", { candidateName: "Rahul" });
    const [a, b] = calls(spy).searches.map((s) => s.containerTags as string[]);
    expect(a.some((t) => b.includes(t))).toBe(false);
    for (const t of [...a, ...b]) expect(t).not.toMatch(/rahul|pds_candidate_/i);
  });

  it("recall reads the hashed tag and the pre-hash identity tag in one round trip", async () => {
    const spy = stubFetch(() => searchResponse(["fact stored before the hash"]));
    const facts = await recallCandidate("guest-abcdefgh", "background", { candidateName: "Petter" });
    expect(facts).toEqual(["fact stored before the hash"]);
    const [search] = calls(spy).searches;
    expect(search.containerTags).toEqual([containerTagFor("guest-abcdefgh"), "pds_user_guest_abcdefgh"]);
    expect(previousContainerTagFor("")).toBeNull();
  });

  it("gives asked questions their own tag, per round type", () => {
    const hr = askedTagFor("guest-abcdefgh", "hr");
    const tech = askedTagFor("guest-abcdefgh", "technical");
    expect(hr).not.toBe(tech);
    expect(hr).not.toBe(containerTagFor("guest-abcdefgh"));
  });
});

describe("recording asked questions (the write that did not exist)", () => {
  it("stores the question under the asked tag, framed so recall can strip it back", () => {
    const spy = stubFetch(() => ({ ok: true, json: async () => ({ id: "x", status: "queued" }) }));
    rememberAskedQuestion("guest-abcdefgh", "hr", "Where do you see yourself in five years?", "Hari");
    const [write] = calls(spy).writes;
    expect(write.containerTags).toEqual([askedTagFor("guest-abcdefgh", "hr")]);
    expect(String(write.content)).toContain("Where do you see yourself in five years?");
    expect(String(write.content)).toContain("interview question:");
  });

  it("stores the ASK out of a turn that also reacted, not the whole turn", () => {
    const spy = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    rememberAskedQuestion(
      "guest-abcdefgh",
      "hr",
      "That's a fair tradeoff, and honestly I'd argue the same. So where do you see yourself in five years?",
      "Hari",
    );
    const [write] = calls(spy).writes;
    expect(String(write.content)).toContain("So where do you see yourself in five years?");
    expect(String(write.content)).not.toContain("fair tradeoff");
  });

  it("writes a given question once, however many times it is recorded", () => {
    const spy = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    for (let i = 0; i < 4; i++) {
      rememberAskedQuestion("guest-abcdefgh", "hr", "Why do you want to join this company specifically?");
    }
    expect(calls(spy).writes).toHaveLength(1);
  });

  it("is readable within the same session, before the store has caught up", () => {
    // Supermemory writes take ~20s to become searchable, so this round's own
    // questions can only come from the in-process record.
    stubFetch(() => ({ ok: true, json: async () => ({}) }));
    rememberAskedQuestion("guest-abcdefgh", "hr", "What is your biggest weakness, and what are you doing about it?");
    expect(peekAskedQuestions("guest-abcdefgh", "hr")).toContain(
      "What is your biggest weakness, and what are you doing about it?",
    );
    // …and not leaked into the other round type, which knows nothing at all.
    expect(peekAskedQuestions("guest-abcdefgh", "technical")).toBeNull();
  });

  it("still works with no API key at all — the in-process record is unconditional", () => {
    vi.stubEnv(KEY_ENV, "");
    const spy = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    rememberAskedQuestion("guest-abcdefgh", "hr", "Why should we hire you over the other candidates?");
    expect(spy).not.toHaveBeenCalled();
    expect(peekAskedQuestions("guest-abcdefgh", "hr")).toHaveLength(1);
  });

  it("ignores turns with no real question in them", () => {
    const spy = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    rememberAskedQuestion("guest-abcdefgh", "hr", "Right?");
    rememberAskedQuestion("guest-abcdefgh", "hr", "   ");
    expect(calls(spy).writes).toHaveLength(0);
  });

  it("does not write back a question it recalled FROM the store", async () => {
    const stored = 'Asked Hari this hr interview question: "Where do you see yourself in five years?"';
    const spy = stubFetch((url) => (url.endsWith("/v3/search") ? searchResponse([stored]) : { ok: true, json: async () => ({}) }));
    await recallAskedQuestions("guest-abcdefgh", "hr");
    rememberAskedQuestion("guest-abcdefgh", "hr", "Where do you see yourself in five years?");
    expect(calls(spy).writes).toHaveLength(0);
  });

  it("strips the stored framing back off on recall", async () => {
    stubFetch(() => searchResponse(['Asked Hari this hr interview question: "Why do you want to join us?"']));
    expect(await recallAskedQuestions("guest-abcdefgh", "hr")).toEqual(["Why do you want to join us?"]);
  });
});

describe("recall never blocks or throws", () => {
  it("peek returns null while cold — the caller runs this turn without memory", () => {
    stubFetch(() => searchResponse(["a fact"]));
    expect(peekRecalledFacts("guest-abcdefgh")).toBeNull();
    expect(peekAskedQuestions("guest-abcdefgh", "hr")).toBeNull();
  });

  it("priming warms both caches so every later turn is a synchronous read", async () => {
    const spy = stubFetch((url) =>
      url.endsWith("/v3/search") ? searchResponse(['Asked Hari this hr interview question: "Why us?"']) : { ok: true, json: async () => ({}) },
    );
    primeCandidateMemory({ subject: "guest-abcdefgh", roundType: "hr", candidateName: "Hari" });
    await vi.waitFor(() => expect(peekAskedQuestions("guest-abcdefgh", "hr")).not.toBeNull());
    expect(peekRecalledFacts("guest-abcdefgh", "Hari")).not.toBeNull();
    // One search per kind of recall, not one per caller.
    const before = calls(spy).searches.length;
    primeCandidateMemory({ subject: "guest-abcdefgh", roundType: "hr", candidateName: "Hari" });
    expect(calls(spy).searches).toHaveLength(before);
  });

  it("collapses concurrent primes into a single request per cache key", async () => {
    const spy = stubFetch(() => searchResponse(["a fact"]));
    await Promise.all([
      recallCandidate("guest-abcdefgh", "q"),
      recallCandidate("guest-abcdefgh", "q"),
      recallCandidate("guest-abcdefgh", "q"),
    ]);
    expect(calls(spy).searches).toHaveLength(1);
  });

  it("degrades to nothing-known on a rejected search, and does not retry every turn", async () => {
    const spy = stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
    expect(await recallCandidate("guest-abcdefgh", "q")).toEqual([]);
    expect(await recallCandidate("guest-abcdefgh", "q")).toEqual([]);
    expect(calls(spy).searches).toHaveLength(1); // the miss is cached
  });

  it("degrades to nothing-known when fetch itself throws", async () => {
    stubFetch(() => {
      throw new Error("offline");
    });
    expect(await recallCandidate("guest-abcdefgh", "q")).toEqual([]);
    expect(await recallAskedQuestions("guest-abcdefgh", "hr")).toEqual([]);
  });

  it("is a complete no-op with no API key", async () => {
    vi.stubEnv(KEY_ENV, "");
    const spy = stubFetch(() => searchResponse(["a fact"]));
    expect(await recallCandidate("guest-abcdefgh", "q")).toEqual([]);
    primeCandidateMemory({ subject: "guest-abcdefgh", roundType: "hr" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores an empty subject rather than writing to a shared bucket", async () => {
    const spy = stubFetch(() => searchResponse(["a fact"]));
    expect(await recallCandidate("  ", "q")).toEqual([]);
    rememberAskedQuestion("  ", "hr", "Tell me about a failure you are willing to own.");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("question text: extracting, comparing, presenting", () => {
  it("takes the substantive question out of a reaction-plus-ask turn", () => {
    expect(extractQuestion("Nice. Sound good? So what happens when you type a URL and press enter?")).toBe(
      "So what happens when you type a URL and press enter?",
    );
  });

  it("falls back to the longest sentence when the ask is phrased as an instruction", () => {
    // The coding exercise has no "?" in it at all, and arrives wrapped in a
    // lead-in that is deliberately varied — keeping it would make the same
    // exercise look new in every session.
    const coding = "Write a Java method that returns the first non-repeating character.";
    expect(extractQuestion(coding)).toBe(coding);
    expect(extractQuestion(`Let's switch gears and get you writing something. The editor is open. ${coding}`)).toBe(coding);
  });

  // Found in the live store: the question "…how you integrated Next.js with
  // Groq, and how the local text-to-speech server fits into the flow?" had
  // been recorded as the fragment "js with Groq, and how …" — the splitter
  // took the dot in "Next.js" for a sentence end.
  it("never splits a sentence at a dot inside a token (Next.js, 8.5, e.g.)", () => {
    const turn =
      "That sounds like a solid project. Can you walk me through how you integrated Next.js with Groq, and how the local text-to-speech server fits into the flow?";
    expect(extractQuestion(turn)).toBe(
      "Can you walk me through how you integrated Next.js with Groq, and how the local text-to-speech server fits into the flow?",
    );
    expect(extractQuestion("You scored 8.5 overall. Why did that dip in year 3.2 of the course?")).toBe(
      "Why did that dip in year 3.2 of the course?",
    );
  });

  it("caps and normalizes so a 1200-char turn cannot become a 1200-char record", () => {
    const long = `${"why ".repeat(200)}?`;
    expect(extractQuestion(long).length).toBeLessThanOrEqual(220);
    expect(extractQuestion("  spread   over\n lines?  ")).toBe("spread over lines?");
    expect(extractQuestion("")).toBe("");
  });

  it("compares questions on meaning-bearing characters only", () => {
    expect(questionKey("Why do you want to join US?")).toBe(questionKey("why do you want to join us"));
  });

  it("matches a stored question against the fixture it came from, truncation included", () => {
    const fixture = "Tell me about a time you worked in a team and things did not go smoothly. What did you do?";
    expect(wasAlreadyAsked(fixture, [fixture])).toBe(true);
    // Stored capped at 220 chars → a prefix of the fixture text.
    expect(wasAlreadyAsked(fixture, [fixture.slice(0, 60)])).toBe(true);
    // Spoken with a lead-in → the fixture is a substring of the stored copy.
    expect(wasAlreadyAsked(fixture, [`Let's switch gears. ${fixture}`])).toBe(true);
  });

  it("does not fire on two different questions that share a stock phrase", () => {
    expect(wasAlreadyAsked("Tell me about yourself.", ["Tell me about a failure you own."])).toBe(false);
    expect(wasAlreadyAsked("Why us?", ["Why do you want to leave your current company?"])).toBe(false);
    expect(wasAlreadyAsked("Where do you see yourself in five years?", [])).toBe(false);
  });

  it("builds a prompt block that forbids rewordings, and nothing at all when empty", () => {
    expect(askedQuestionsBlock([])).toBe("");
    const block = askedQuestionsBlock(["Why us?", "Where do you see yourself in five years?", "Why us?"]);
    expect(block).toContain("ALREADY ASKED");
    expect(block).toContain("in any rewording");
    expect(block).toContain("- Why us?");
    // Deduped, and capped so it cannot out-shout the transcript.
    expect(block.split("\n- ")).toHaveLength(3);
    const many = Array.from({ length: 30 }, (_, i) => `Question number ${i} about your work?`);
    expect(askedQuestionsBlock(many).split("\n- ")).toHaveLength(13);
  });
});
