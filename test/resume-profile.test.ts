import { describe, expect, it } from "vitest";
import { buildResumeProfile } from "@/lib/resume-profile";

const FRESHER_RESUME = `Sai Gogineni
sai@example.com | Hyderabad
EDUCATION
B.Tech in Computer Science, JNTU Hyderabad, 2021-2025, CGPA 8.4
SKILLS
Java, Python, DSA, Data Structures, Algorithms, React, Node.js, MongoDB, Git, Full Stack
PROJECTS
Placement Day Simulator
- Voice-first AI mock interviewer built with Next.js and TypeScript
- Cut interviewer response latency by 40% with speculative execution
Campus Cart
- Full stack grocery app for hostels using React and Node.js
`;

const EXPERIENCED_RESUME = `RAHUL VERMA
rahul.verma@mail.com
WORK EXPERIENCE
Senior Software Engineer, Infosys Technologies, 2023 - Present
- Led a team of 5 building payment microservices in Java and Spring Boot
Software Engineer, Wipro Solutions, 2021 - 2023
- Built REST APIs in Python serving 2 million requests a day
EDUCATION
B.Tech, NIT Warangal, 2017-2021
SKILLS
Java, Spring Boot, Python, SQL, AWS, Kubernetes, System Design
`;

const INTERN_ONLY_RESUME = `Priya Nair
priya@mail.com
INTERNSHIPS
Software Engineering Intern, Zoho, May 2024 - Jul 2024
- Built dashboards in React
EDUCATION
B.Tech, Anna University, 2021-2025
`;

describe("buildResumeProfile — fresher resume", () => {
  const p = buildResumeProfile(FRESHER_RESUME);

  it("detects the name from the first line", () => {
    expect(p.name).toBe("Sai Gogineni");
  });

  it("stays a fresher: education year ranges never count as work experience", () => {
    expect(p.experienced).toBe(false);
    expect(p.yearsOfExperience).toBeUndefined();
    expect(p.companies).toEqual([]);
  });

  it("extracts dictionary skills, deduped, capped at 10", () => {
    expect(p.skills).toContain("DSA");
    expect(p.skills).toContain("Java");
    expect(p.skills).toContain("React");
    expect(p.skills).toContain("Full Stack");
    expect(p.skills.length).toBeLessThanOrEqual(10);
    expect(new Set(p.skills).size).toBe(p.skills.length);
  });

  it("extracts projects: header line = name, bullets squashed into a ≤160-char summary", () => {
    expect(p.projects.map((x) => x.name)).toEqual(["Placement Day Simulator", "Campus Cart"]);
    expect(p.projects[0].summary).toContain("Voice-first AI mock interviewer");
    expect(p.projects[0].summary.length).toBeLessThanOrEqual(160);
  });

  it("finds the education line and a metric-bearing highlight", () => {
    expect(p.education).toContain("B.Tech in Computer Science");
    expect(p.highlight).toContain("40%");
  });
});

describe("buildResumeProfile — experienced resume", () => {
  const p = buildResumeProfile(EXPERIENCED_RESUME);

  it("flags experience and sums year ranges (present resolves in-document)", () => {
    expect(p.experienced).toBe(true);
    expect(p.yearsOfExperience).toBe(3); // 2023→2024(present proxy) + 2021→2023
  });

  it("lists companies in resume order (most recent first), cap 4", () => {
    expect(p.companies).toEqual(["Infosys Technologies", "Wipro Solutions"]);
  });

  it("keeps the education line separate from work history", () => {
    expect(p.education).toContain("NIT Warangal");
  });
});

describe("buildResumeProfile — intern-only resume (fresher-with-internship rule)", () => {
  const p = buildResumeProfile(INTERN_ONLY_RESUME);

  it("never counts internships toward experienced", () => {
    expect(p.experienced).toBe(false);
    expect(p.yearsOfExperience).toBeUndefined();
  });

  it("still extracts the internship company", () => {
    expect(p.companies).toEqual(["Zoho"]);
  });
});

describe("buildResumeProfile — edges", () => {
  it("returns the empty profile for empty and whitespace-only text", () => {
    const empty = { experienced: false, companies: [], skills: [], projects: [] };
    expect(buildResumeProfile("")).toEqual(empty);
    expect(buildResumeProfile("   \n\n  ")).toEqual(empty);
  });

  it("falls back to the top skill cluster for the highlight when no projects exist", () => {
    const p = buildResumeProfile("Anil Kumar\nSKILLS\nJava, Python, DSA");
    expect(p.projects).toEqual([]);
    expect(p.highlight).toBe(p.skills.slice(0, 3).join(", "));
  });

  it("rejects non-name first lines: banners, digits, emails, casing, word count", () => {
    expect(buildResumeProfile("RESUME\nSai Gogineni\nSKILLS\nJava").name).toBeUndefined();
    expect(buildResumeProfile("Sai Gogineni 9876543210\nSKILLS\nJava").name).toBeUndefined();
    expect(buildResumeProfile("sai.g@mail.com\nSKILLS\nJava").name).toBeUndefined();
    expect(buildResumeProfile("sai gogineni\nSKILLS\nJava").name).toBeUndefined();
    expect(buildResumeProfile("Sai\nSKILLS\nJava").name).toBeUndefined();
    expect(buildResumeProfile("Sai Venkata Rama Krishna Gogineni Junior\nSKILLS\nJava").name).toBeUndefined();
  });

  it("accepts 2-4 capitalized words as a name, including ALL-CAPS", () => {
    expect(buildResumeProfile("SAI GOGINENI\nSKILLS\nJava").name).toBe("SAI GOGINENI");
    expect(buildResumeProfile("Sai Venkata Gogineni\nSKILLS\nJava").name).toBe("Sai Venkata Gogineni");
  });

  it("an aspiring-engineer objective line never flips a fresher to experienced", () => {
    const p = buildResumeProfile("Anil Kumar\nAspiring software engineer passionate about DSA\nSKILLS\nJava");
    expect(p.experienced).toBe(false);
  });

  it("word-boundary skill matching: javascript never implies java", () => {
    const p = buildResumeProfile("Anil Kumar\nSKILLS\nJavaScript, TypeScript");
    expect(p.skills).toContain("JavaScript");
    expect(p.skills).not.toContain("Java");
    expect(p.skills).not.toContain("C");
  });

  it("is deterministic: same text, same profile", () => {
    expect(buildResumeProfile(EXPERIENCED_RESUME)).toEqual(buildResumeProfile(EXPERIENCED_RESUME));
    expect(buildResumeProfile(FRESHER_RESUME)).toEqual(buildResumeProfile(FRESHER_RESUME));
  });
});
