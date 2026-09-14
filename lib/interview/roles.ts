import type { RolePreset } from "@/lib/types";

// Role families and the competency catalog they are assessed on.
//
// A role is not a question list. It decides WHAT the interview has to find out
// (competencies, which of them are required, how much each weighs), how deep it
// starts (difficulty), what a strong or weak answer looks like (rubric anchors),
// what the fallback interviewer can ask when the model is unavailable (probes),
// and what the report tells the candidate to study. Every one of those flows
// from the tables below, so adding a role is a data change, not a code change.

export type RoleFamily =
  | "sde"
  | "fullstack"
  | "frontend"
  | "backend"
  | "java"
  | "python"
  | "data-analyst"
  | "devops"
  | "qa"
  | "ai-ml"
  | "hr-behavioural";

export type Difficulty = 1 | 2 | 3;
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { 1: "foundation", 2: "intermediate", 3: "advanced" };

export interface CompetencyDef {
  id: string;
  label: string;
  /** Lower-case terms whose presence in an answer is evidence about this
   * competency. Multi-word terms match as phrases. */
  keywords: string[];
  /** Deterministic probes per difficulty — the fallback interviewer's material
   * and the prompt's hint of what "going deeper" means here. */
  probes: Record<Difficulty, string[]>;
  rubric: { strong: string; weak: string };
  study: string[];
  /** Not scored (e.g. relocation/package logistics) — coverage only. */
  unscored?: boolean;
}

const c = (def: CompetencyDef): CompetencyDef => def;

export const COMPETENCIES: Record<string, CompetencyDef> = {
  // ——— technical ———
  projects: c({
    id: "projects",
    label: "Project depth & ownership",
    keywords: ["project", "built", "implemented", "architecture", "deployed", "users", "feature", "bug", "designed", "my part", "i wrote", "module", "repository", "github"],
    probes: {
      1: ["Walk me through the project you're proudest of — what does it do, and which part did you build yourself?", "What was the hardest bug you hit in that project, and how did you find it?"],
      2: ["Why did you structure that project the way you did — what alternative did you consider and reject?", "If ten times as many people used that project tomorrow, what would break first?"],
      3: ["What would you redesign in that project today, and what would the migration cost you?", "Which technical decision in that project turned out wrong, and how did you find out?"],
    },
    rubric: { strong: "names their own contribution, concrete decisions, tradeoffs and outcomes", weak: "describes the project in team terms with no personal decisions or specifics" },
    study: ["Prepare a 2-minute walkthrough of one project: problem, your part, one decision, one result", "Know the architecture of your own project well enough to draw it", "Have a real bug story ready: symptom, investigation, fix, prevention"],
  }),
  dsa: c({
    id: "dsa",
    label: "Data structures & algorithms",
    keywords: ["array", "hash", "hashmap", "map", "set", "stack", "queue", "heap", "tree", "graph", "linked list", "binary search", "sort", "recursion", "dynamic programming", "complexity", "o(n)", "o(1)", "o(log n)", "big o", "two pointer", "sliding window", "bfs", "dfs"],
    probes: {
      1: ["When would you use a hash map instead of an array, and what does that choice cost you?", "Explain how binary search works and when you're allowed to use it."],
      2: ["How would you find the top ten scores in a million records without sorting everything?", "Walk me through detecting a cycle in a linked list — and the complexity of your approach."],
      3: ["How would you find the shortest path in a weighted graph, and when does your approach break?", "Design an LRU cache with O(1) get and put — which structures, and why both?"],
    },
    rubric: { strong: "chooses structures deliberately and states correct time/space complexity", weak: "names structures without reasoning, or gets complexity wrong" },
    study: ["Hash maps: collisions, load factor, worst-case complexity", "Heaps and priority queues for top-k problems", "Graph traversal: BFS vs DFS and when each fits", "Practise stating time and space complexity out loud for every solution"],
  }),
  "problem-solving": c({
    id: "problem-solving",
    label: "Problem solving & coding",
    keywords: ["approach", "edge case", "test", "brute force", "optimize", "constraint", "input", "output", "loop", "function", "return", "null", "empty", "complexity", "tradeoff", "trade-off"],
    probes: {
      1: ["Before you write any code for a problem, what do you do first?", "Which edge cases would you test for a function that reverses a string?"],
      2: ["Your solution works but is too slow for the largest input. Walk me through how you'd find and fix the bottleneck.", "How do you decide when a brute-force solution is good enough?"],
      3: ["How would you prove your algorithm is correct rather than just testing it?", "Where exactly does your solution stop scaling, and what would you change first?"],
    },
    rubric: { strong: "clarifies the problem, reasons about edge cases and complexity, explains the approach", weak: "jumps to code without a plan, misses edge cases, cannot explain the approach" },
    study: ["Practise the clarify → examples → approach → code → test loop out loud", "Build an edge-case checklist: empty, single element, duplicates, very large input", "Time yourself on two medium problems a day and explain each solution aloud"],
  }),
  "cs-fundamentals": c({
    id: "cs-fundamentals",
    label: "CS fundamentals (OS, networks, DBMS)",
    keywords: ["process", "thread", "memory", "deadlock", "cache", "tcp", "udp", "http", "dns", "index", "transaction", "normalization", "operating system", "virtual memory", "mutex", "scheduling"],
    probes: {
      1: ["What's the difference between a process and a thread?", "What happens when you type a URL into a browser and press enter?"],
      2: ["What is a deadlock, and how would you prevent one in code you write?", "Why do databases use indexes, and what do they cost?"],
      3: ["How does virtual memory let a program use more memory than physically exists?", "When would you pick UDP over TCP, and what do you give up?"],
    },
    rubric: { strong: "explains mechanisms and their costs, not just definitions", weak: "recites definitions without understanding when or why they matter" },
    study: ["Processes vs threads, context switching, synchronization", "TCP handshake, HTTP request lifecycle, DNS resolution", "Database indexes, transactions and ACID"],
  }),
  oop: c({
    id: "oop",
    label: "OOP & design",
    keywords: ["class", "object", "inheritance", "polymorphism", "encapsulation", "abstraction", "interface", "abstract class", "composition", "solid", "design pattern", "singleton", "factory", "override", "overload"],
    probes: {
      1: ["Explain polymorphism with an example from code you've written.", "What's the difference between an interface and an abstract class?"],
      2: ["When would you prefer composition over inheritance? Give me a concrete case.", "Pick one SOLID principle and show me where breaking it hurt a codebase."],
      3: ["Design the classes for a parking lot system — what are the core abstractions and why?", "Which design pattern have you seen overused, and what would you do instead?"],
    },
    rubric: { strong: "applies OOP ideas to real design decisions with tradeoffs", weak: "defines terms without being able to apply them" },
    study: ["The four OOP pillars with one real example each", "Composition vs inheritance tradeoffs", "SOLID principles, and a low-level design problem (parking lot, library system)"],
  }),
  java: c({
    id: "java",
    label: "Java & JVM",
    keywords: ["java", "jvm", "garbage collection", "gc", "heap", "stack", "hashmap", "arraylist", "string", "immutable", "thread", "synchronized", "stream", "lambda", "exception", "spring", "spring boot", "collections", "generics", "jdk"],
    probes: {
      1: ["Why are strings immutable in Java, and what does that buy you?", "What's the difference between an ArrayList and a LinkedList in practice?"],
      2: ["How does a HashMap work internally, and what happens when keys collide?", "What does the garbage collector do, and how can a Java program still run out of memory?"],
      3: ["HashMap versus ConcurrentHashMap — what breaks if you pick the wrong one under load?", "How would you track down a memory leak in a running Java service?"],
    },
    rubric: { strong: "explains JVM and collection internals and their practical consequences", weak: "knows syntax but not how the runtime or collections behave" },
    study: ["HashMap internals: hashing, buckets, resizing, treeification", "JVM memory model and garbage collection basics", "Concurrency: synchronized, volatile, ConcurrentHashMap, executors", "Exceptions: checked vs unchecked and when to use each"],
  }),
  python: c({
    id: "python",
    label: "Python",
    keywords: ["python", "list", "dict", "dictionary", "tuple", "generator", "decorator", "comprehension", "gil", "pandas", "numpy", "django", "flask", "fastapi", "virtualenv", "pip", "async", "iterator", "lambda"],
    probes: {
      1: ["What's the difference between a list and a tuple, and when does it matter?", "What does a list comprehension give you over a loop?"],
      2: ["How do generators work, and why would you use one for a large file?", "What is a decorator? Show me one you'd actually write."],
      3: ["What is the GIL, and how does it change the way you'd make Python code faster?", "How are Python dictionaries implemented, and what makes lookups fast?"],
    },
    rubric: { strong: "uses Python idioms deliberately and understands the runtime tradeoffs", weak: "writes Python like another language without knowing its idioms or limits" },
    study: ["Generators, iterators and lazy evaluation", "Decorators and context managers", "The GIL: threading vs multiprocessing vs asyncio", "dict and set internals"],
  }),
  javascript: c({
    id: "javascript",
    label: "JavaScript & TypeScript",
    keywords: ["javascript", "typescript", "closure", "promise", "async", "await", "event loop", "callback", "this", "prototype", "hoisting", "let", "const", "var", "===", "type", "interface"],
    probes: {
      1: ["What's the difference between let, const and var?", "What is a closure? Give me a situation where you'd use one."],
      2: ["Explain the event loop — why can a setTimeout of zero still run late?", "How do promises and async/await relate, and how do you handle errors with each?"],
      3: ["How does prototypal inheritance differ from class-based inheritance?", "What problems does TypeScript actually catch, and where does it still let bugs through?"],
    },
    rubric: { strong: "explains the event loop, closures and async behaviour precisely", weak: "uses async code by rote without knowing execution order" },
    study: ["The event loop: call stack, microtasks, macrotasks", "Closures and scope", "Promises, async/await and error handling", "TypeScript types vs runtime checks"],
  }),
  "frontend-ui": c({
    id: "frontend-ui",
    label: "Frontend engineering (React/UI)",
    keywords: ["react", "component", "state", "props", "hook", "useeffect", "usestate", "render", "virtual dom", "css", "layout", "accessibility", "responsive", "next.js", "redux", "context", "angular", "vue"],
    probes: {
      1: ["What's the difference between state and props in React?", "How would you make a page layout work on both phones and laptops?"],
      2: ["What triggers a re-render in React, and how do you find renders you didn't need?", "When would you lift state up versus reach for context or a store?"],
      3: ["How would you keep a large React app fast as it grows — what do you measure first?", "How do you make a complex component accessible to screen-reader users?"],
    },
    rubric: { strong: "reasons about rendering, state ownership and UX tradeoffs", weak: "builds components without knowing why they re-render or where state belongs" },
    study: ["React rendering and reconciliation", "State management: local, lifted, context, stores", "Accessibility basics: semantics, focus, ARIA", "CSS layout: flexbox, grid, responsive design"],
  }),
  "web-fundamentals": c({
    id: "web-fundamentals",
    label: "Web fundamentals",
    keywords: ["http", "https", "rest", "cookie", "cors", "cache", "browser", "dom", "status code", "request", "response", "header", "session", "token", "performance", "lighthouse", "cdn"],
    probes: {
      1: ["What's the difference between a GET and a POST request?", "What does a 404 mean versus a 500?"],
      2: ["What is CORS, and why does the browser enforce it?", "How would you work out why a page loads slowly on a cheap phone?"],
      3: ["How does HTTP caching work, and how would you cache an API response safely?", "Cookies versus tokens for authentication — what are the security tradeoffs?"],
    },
    rubric: { strong: "understands how browsers and HTTP behave and uses that to debug", weak: "knows frameworks but not the web platform underneath" },
    study: ["HTTP methods, status codes and headers", "CORS and same-origin policy", "Browser caching and CDNs", "Core Web Vitals and performance profiling"],
  }),
  "backend-apis": c({
    id: "backend-apis",
    label: "Backend & API design",
    keywords: ["api", "rest", "endpoint", "authentication", "authorization", "jwt", "middleware", "server", "microservice", "rate limit", "pagination", "idempotent", "spring boot", "express", "django", "flask", "node", "controller", "service layer"],
    probes: {
      1: ["What makes an API RESTful? Walk me through designing endpoints for a to-do app.", "How does a server know which user is making a request?"],
      2: ["How would you add pagination to an endpoint that returns thousands of records?", "What does it mean for an API call to be idempotent, and why does it matter for payments?"],
      3: ["How would you rate-limit an API across several server instances?", "How would you version an API without breaking the clients already using it?"],
    },
    rubric: { strong: "designs APIs around correctness, security and failure modes", weak: "describes endpoints without considering auth, errors or scale" },
    study: ["REST design: resources, status codes, pagination", "Authentication vs authorization; sessions vs JWT", "Idempotency and retries", "Rate limiting and caching strategies"],
  }),
  databases: c({
    id: "databases",
    label: "SQL & databases",
    keywords: ["sql", "query", "join", "index", "primary key", "foreign key", "normalization", "transaction", "postgres", "postgresql", "mysql", "mongodb", "schema", "group by", "aggregate", "nosql", "acid"],
    probes: {
      1: ["What's the difference between an inner join and a left join?", "What is a primary key, and why does every table need one?"],
      2: ["A query got slow as the table grew. How would you find out why and fix it?", "When would you denormalize a schema on purpose?"],
      3: ["How do transaction isolation levels trade correctness for speed?", "When would you choose a document database over a relational one, and what do you lose?"],
    },
    rubric: { strong: "writes and reasons about queries, indexes and transactions correctly", weak: "can name SQL keywords but cannot reason about query cost or integrity" },
    study: ["Joins, GROUP BY and window functions", "Indexes and reading a query plan", "Normalization vs denormalization", "Transactions and isolation levels"],
  }),
  "system-design": c({
    id: "system-design",
    label: "System design",
    keywords: ["scale", "scalability", "load balancer", "cache", "queue", "replication", "sharding", "availability", "consistency", "latency", "throughput", "bottleneck", "microservices", "monolith", "cdn", "kafka"],
    probes: {
      1: ["What does it mean for a system to scale horizontally versus vertically?", "Why would you put a cache in front of a database?"],
      2: ["Design a URL shortener — what are the main components and where is the bottleneck?", "When would you introduce a message queue between two services?"],
      3: ["How would you keep data consistent when one service writes to two databases?", "Your service's p99 latency doubled overnight. How do you investigate?"],
    },
    rubric: { strong: "identifies bottlenecks and explains tradeoffs between designs", weak: "lists technologies without explaining why they fit" },
    study: ["Caching, load balancing and replication basics", "Queues and asynchronous processing", "CAP theorem and consistency tradeoffs", "Practise one classic design (URL shortener, rate limiter) end to end"],
  }),
  "cloud-devops": c({
    id: "cloud-devops",
    label: "Cloud, containers & CI/CD",
    keywords: ["docker", "container", "kubernetes", "k8s", "ci/cd", "pipeline", "jenkins", "github actions", "aws", "azure", "gcp", "terraform", "deploy", "deployment", "infrastructure", "ec2", "s3", "helm", "yaml"],
    probes: {
      1: ["What problem does a Docker container solve compared to just running the app?", "Walk me through what a CI/CD pipeline does when you push a commit."],
      2: ["How would you roll out a new version without downtime, and roll it back if it fails?", "What's the difference between a Docker image and a container, and how do you keep images small?"],
      3: ["How does Kubernetes decide where to run a pod, and what happens when a node dies?", "How would you manage infrastructure for three environments without them drifting apart?"],
    },
    rubric: { strong: "explains deployment mechanics, failure handling and automation tradeoffs", weak: "names tools without understanding what they do under the hood" },
    study: ["Docker images, layers and multi-stage builds", "CI/CD pipeline stages and deployment strategies (blue-green, canary)", "Kubernetes basics: pods, deployments, services", "Infrastructure as code with Terraform"],
  }),
  "networking-linux": c({
    id: "networking-linux",
    label: "Linux & networking",
    keywords: ["linux", "bash", "shell", "process", "permission", "ssh", "port", "dns", "tcp", "ip", "firewall", "subnet", "cron", "systemd", "grep", "log", "nginx", "load balancer"],
    probes: {
      1: ["How would you find which process is using a port on a Linux machine?", "What do file permissions like 755 mean?"],
      2: ["A server can't reach a database in another subnet. How do you debug it step by step?", "How does DNS resolution work when a service calls another by name?"],
      3: ["A Linux box is at 100% CPU and SSH is sluggish. What do you check, in order?", "How would you design network access so only the app tier can reach the database?"],
    },
    rubric: { strong: "debugs systematically with real commands and network reasoning", weak: "guesses at causes without a method or the commands to test them" },
    study: ["Core Linux commands: ps, top, lsof, netstat/ss, journalctl", "File permissions and users", "TCP/IP, subnets, DNS and ports", "Systematic troubleshooting of connectivity"],
  }),
  monitoring: c({
    id: "monitoring",
    label: "Monitoring & incident response",
    keywords: ["monitoring", "alert", "logging", "metrics", "prometheus", "grafana", "incident", "on-call", "sla", "slo", "dashboard", "tracing", "root cause", "postmortem", "uptime"],
    probes: {
      1: ["What's the difference between logs and metrics?", "What would you put on a dashboard for a web service?"],
      2: ["You get paged at 2am because error rates spiked. What are your first five minutes?", "How do you decide what deserves an alert versus a dashboard?"],
      3: ["How would you define SLOs for a service, and what happens when you burn the error budget?", "Walk me through running a blameless postmortem."],
    },
    rubric: { strong: "responds to incidents methodically and designs actionable monitoring", weak: "has no clear method for detection, triage or follow-up" },
    study: ["Logs, metrics and traces", "Alert design and avoiding alert fatigue", "SLIs, SLOs and error budgets", "Incident response and postmortems"],
  }),
  "testing-qa": c({
    id: "testing-qa",
    label: "Testing strategy",
    keywords: ["test case", "test cases", "unit test", "integration test", "regression", "boundary", "equivalence", "bug report", "severity", "priority", "test plan", "coverage", "smoke", "sanity", "manual testing", "defect"],
    probes: {
      1: ["How would you test a login page? Give me your first five test cases.", "What's the difference between severity and priority for a bug?"],
      2: ["What is boundary value analysis? Apply it to an age field that accepts 18 to 60.", "How do you decide what to regression-test when time is short?"],
      3: ["How would you build a test strategy for a payments feature from scratch?", "A bug only happens in production and never in testing. How do you chase it?"],
    },
    rubric: { strong: "designs risk-based tests with boundaries, negatives and clear bug reports", weak: "tests only the happy path and cannot prioritise" },
    study: ["Boundary value analysis and equivalence partitioning", "Writing clear bug reports: steps, expected, actual", "Test pyramid: unit, integration, end-to-end", "Risk-based regression selection"],
  }),
  automation: c({
    id: "automation",
    label: "Test automation",
    keywords: ["selenium", "cypress", "playwright", "automation", "framework", "page object", "locator", "xpath", "assertion", "flaky", "testng", "junit", "pytest", "api testing", "postman", "ci"],
    probes: {
      1: ["Which automation tool have you used, and what did you automate with it?", "What is a locator, and which kind do you prefer?"],
      2: ["What is the page object model, and what problem does it solve?", "How do you deal with a flaky automated test?"],
      3: ["How would you design an automation framework that five teams could share?", "When is automating a test a waste of time?"],
    },
    rubric: { strong: "builds maintainable, reliable automation and knows when not to automate", weak: "records scripts without structure and cannot handle flakiness" },
    study: ["Page object model and framework structure", "Stable locators and waiting strategies", "API testing with Postman or REST clients", "Running tests in CI and handling flakiness"],
  }),
  "data-analysis": c({
    id: "data-analysis",
    label: "Data analysis",
    keywords: ["pandas", "excel", "dataset", "clean", "missing values", "outlier", "pivot", "aggregate", "groupby", "insight", "analysis", "kpi", "metric", "trend", "cohort", "funnel", "retention"],
    probes: {
      1: ["How would you handle missing values in a dataset before analysing it?", "What's a KPI you would track for a food-delivery app, and why that one?"],
      2: ["Sales dropped 15% last month. How would you find out why?", "How do you spot and deal with outliers without throwing away real signal?"],
      3: ["How would you design a cohort retention analysis, and what would it tell a product team?", "Two dashboards show different numbers for the same metric. How do you resolve it?"],
    },
    rubric: { strong: "structures an investigation and turns data into a defensible insight", weak: "describes tools without a method for reaching a conclusion" },
    study: ["Data cleaning: missing values, duplicates, outliers", "Root-cause analysis of a metric drop", "Cohort and funnel analysis", "pandas groupby, merge and pivot tables"],
  }),
  statistics: c({
    id: "statistics",
    label: "Statistics & experimentation",
    keywords: ["mean", "median", "standard deviation", "variance", "distribution", "probability", "hypothesis", "p-value", "a/b test", "confidence interval", "correlation", "causation", "sample", "significance", "regression"],
    probes: {
      1: ["When would you report the median instead of the mean?", "What's the difference between correlation and causation? Give an example."],
      2: ["What does a p-value actually tell you?", "How would you design an A/B test for a new checkout button?"],
      3: ["Your A/B test shows a significant win after two days. Do you ship it? Why or why not?", "How would you detect that a model's input distribution has shifted?"],
    },
    rubric: { strong: "applies statistical reasoning correctly and names its limits", weak: "misreads significance or confuses correlation with causation" },
    study: ["Descriptive statistics and distributions", "Hypothesis testing and p-values", "A/B test design: sample size, duration, peeking", "Correlation vs causation"],
  }),
  visualization: c({
    id: "visualization",
    label: "Visualization & storytelling",
    keywords: ["dashboard", "chart", "tableau", "power bi", "visualization", "bar chart", "line chart", "stakeholder", "story", "report", "audience", "insight", "presentation"],
    probes: {
      1: ["Which chart would you use to show sales over twelve months, and why?", "Who was the audience for the last dashboard or report you made?"],
      2: ["How do you present a finding that contradicts what a stakeholder believes?", "How do you decide what NOT to put on a dashboard?"],
      3: ["Design an executive dashboard for a subscription business — which five numbers, and why those?", "How can a chart be technically correct and still mislead?"],
    },
    rubric: { strong: "chooses visuals for the audience and leads with the decision", weak: "shows everything without a clear message" },
    study: ["Choosing chart types for the question being asked", "Dashboard design for decision-makers", "Presenting an insight: context, finding, recommendation"],
  }),
  "ml-fundamentals": c({
    id: "ml-fundamentals",
    label: "ML fundamentals",
    keywords: ["model", "training", "overfitting", "underfitting", "bias", "variance", "regularization", "cross validation", "precision", "recall", "f1", "accuracy", "loss", "gradient descent", "feature", "neural network", "classification", "regression", "dataset"],
    probes: {
      1: ["What's the difference between overfitting and underfitting?", "Why isn't accuracy a good metric for a fraud-detection model?"],
      2: ["How does regularization reduce overfitting?", "Walk me through how you'd evaluate a classifier before trusting it."],
      3: ["Explain the bias–variance tradeoff with a decision you'd actually make.", "Your model is great offline and poor in production. What are the likely causes?"],
    },
    rubric: { strong: "explains model behaviour and evaluation with correct intuition", weak: "trains models without understanding evaluation or failure modes" },
    study: ["Bias–variance tradeoff and regularization", "Evaluation: precision, recall, F1, ROC-AUC, cross-validation", "Feature engineering and data leakage", "Gradient descent intuition"],
  }),
  "ml-engineering": c({
    id: "ml-engineering",
    label: "ML engineering & GenAI",
    keywords: ["deploy", "inference", "pipeline", "mlops", "llm", "prompt", "embedding", "vector", "rag", "fine-tune", "fine tuning", "latency", "monitoring", "drift", "api", "pytorch", "tensorflow", "hugging face"],
    probes: {
      1: ["How would you serve a trained model so a web app can use it?", "What is an embedding, in plain words?"],
      2: ["How does retrieval-augmented generation work, and when would you use it instead of fine-tuning?", "How would you monitor a model after it's deployed?"],
      3: ["Your LLM feature is slow and expensive. What would you change first?", "How would you evaluate whether an LLM-based answer is actually correct?"],
    },
    rubric: { strong: "connects models to production concerns: latency, cost, monitoring, evaluation", weak: "knows notebooks but not how models run reliably in a product" },
    study: ["Model serving and batching", "RAG vs fine-tuning tradeoffs", "Embeddings and vector search", "Monitoring for drift and quality"],
  }),

  // ——— behavioural ———
  communication: c({
    id: "communication",
    label: "Communication & clarity",
    keywords: ["explained", "presented", "convinced", "listened", "feedback", "stakeholder", "clarified", "wrote", "documentation"],
    probes: {
      1: ["Tell me about yourself — keep it to what matters for this role.", "How would you explain your final-year project to someone who isn't technical?"],
      2: ["Tell me about a time you had to explain something complex to someone who disagreed with you.", "How do you make sure a teammate actually understood what you meant?"],
      3: ["Tell me about a time your message was misunderstood. What did it cost, and what do you do differently now?", "How would you deliver bad news about a missed deadline to a manager?"],
    },
    rubric: { strong: "answers directly with a clear structure and concrete detail", weak: "rambles, stays generic, or never reaches the point" },
    study: ["Answer first, then support it: point → example → result", "Practise a crisp 60-second self-introduction", "Use the STAR structure for stories"],
  }),
  ownership: c({
    id: "ownership",
    label: "Ownership & initiative",
    keywords: ["i took", "i decided", "i owned", "responsible", "initiative", "volunteered", "led", "fixed", "i proposed", "accountable", "without being asked"],
    probes: {
      1: ["Tell me about something you took responsibility for without being asked.", "What's one thing you built or organised that wouldn't exist without you?"],
      2: ["Tell me about a time something you owned went wrong. What did you do first?", "When did you push a change through that others were unsure about?"],
      3: ["Tell me about a decision you owned that turned out to be wrong. How did you handle it?", "When have you had to choose between finishing your own task and unblocking the team?"],
    },
    rubric: { strong: "uses first-person decisions and owns outcomes, including failures", weak: "describes what 'we' did and deflects responsibility" },
    study: ["Prepare two stories where YOU made the decision", "Practise owning a failure without blaming others", "Quantify the outcome of work you drove"],
  }),
  teamwork: c({
    id: "teamwork",
    label: "Teamwork & conflict",
    keywords: ["team", "teammate", "conflict", "disagreed", "collaborated", "helped", "compromise", "together", "group", "resolved", "discussion"],
    probes: {
      1: ["Tell me about a time you worked in a team — what was your role?", "How do you usually handle a teammate who isn't pulling their weight?"],
      2: ["Tell me about a time your team disagreed with you. What happened?", "Describe a conflict in a group project and how it got resolved."],
      3: ["Tell me about a time you had to work with someone difficult for weeks. What did you change?", "When have you backed a team decision you personally disagreed with?"],
    },
    rubric: { strong: "shows specific actions to resolve friction and credits others fairly", weak: "stays abstract about 'good communication' or blames teammates" },
    study: ["STAR stories for conflict and collaboration", "Show what YOU did in a team, not just the team result", "Practise describing a disagreement neutrally"],
  }),
  adaptability: c({
    id: "adaptability",
    label: "Learning & adaptability",
    keywords: ["learned", "new", "quickly", "adapted", "changed", "deadline", "pressure", "figured out", "documentation", "course", "self-taught", "unfamiliar"],
    probes: {
      1: ["Tell me about something you had to learn quickly. How did you go about it?", "What do you do when you're stuck on something you've never seen before?"],
      2: ["Tell me about a time requirements changed late. How did you adapt?", "How did you decide what NOT to learn when you were short on time?"],
      3: ["Tell me about a time your usual approach stopped working. What did you change about how you work?", "How do you handle two deadlines landing on the same day?"],
    },
    rubric: { strong: "describes a concrete learning strategy and how it paid off under constraints", weak: "claims to be a fast learner with no evidence" },
    study: ["Prepare a 'learned under pressure' STAR story", "Explain your personal learning process in three steps", "Show prioritisation when time is short"],
  }),
  motivation: c({
    id: "motivation",
    label: "Motivation & role fit",
    keywords: ["because", "interested", "passionate", "goal", "career", "company", "role", "growth", "why", "five years", "long term", "product", "mission"],
    probes: {
      1: ["Why this role, and why now?", "What are you hoping to learn in your first year?"],
      2: ["What do you know about what this job involves day to day, and which part excites you least?", "Where do you see yourself in three to five years, and how does this role get you there?"],
      3: ["If you got two offers tomorrow, what would decide between them?", "What would make you leave a job in the first year?"],
    },
    rubric: { strong: "gives specific, role-connected reasons and realistic goals", weak: "generic motivation that could apply to any company or role" },
    study: ["Research the role's day-to-day work before interviews", "Connect one of your projects to the role", "Prepare a realistic 3–5 year goal"],
  }),
  "self-awareness": c({
    id: "self-awareness",
    label: "Self-awareness & growth",
    keywords: ["weakness", "improve", "feedback", "mistake", "failure", "working on", "learned", "reflect", "strength"],
    probes: {
      1: ["What's a strength you have, and which project proves it?", "What's one thing you're actively working to improve?"],
      2: ["Tell me about the most useful criticism you've received. What did you do that week?", "Tell me about a failure you're willing to own. What changed afterwards?"],
      3: ["What would your harshest reviewer say about your work, and are they right?", "Which of your habits has cost you the most, and how do you know?"],
    },
    rubric: { strong: "names real weaknesses with evidence and concrete action taken", weak: "offers disguised strengths or rehearsed non-answers" },
    study: ["Prepare an honest weakness with a real improvement plan", "Use evidence for every strength you claim", "Practise talking about a failure without defensiveness"],
  }),
  pressure: c({
    id: "pressure",
    label: "Handling pressure",
    keywords: ["pressure", "deadline", "stress", "prioritize", "prioritise", "calm", "urgent", "overnight", "escalated", "tradeoff"],
    probes: {
      1: ["Tell me about a tight deadline you worked to. How did you plan it?", "What do you do when you feel overwhelmed by work?"],
      2: ["Tell me about a time something broke right before a submission or release.", "How do you prioritise when everything looks urgent?"],
      3: ["Tell me about a time you had to push back on an unrealistic deadline.", "When has pressure made you make a bad call, and what did you learn?"],
    },
    rubric: { strong: "shows a calm, prioritised approach with concrete actions", weak: "describes stress without any method for handling it" },
    study: ["Prepare a deadline story with a clear prioritisation step", "Practise saying no or negotiating scope politely"],
  }),
  logistics: c({
    id: "logistics",
    label: "Practicalities",
    keywords: ["relocate", "relocation", "package", "ctc", "salary", "notice period", "joining", "location", "shift"],
    probes: {
      1: ["Are you open to relocating if the role needs it?", "What are your expectations on the package? I'll only ask once."],
      2: ["What's your notice period, and is there flexibility?", "Is there anything that would stop you joining in the next two months?"],
      3: ["If the offer came in below your expectation, what would you do?", "How do you weigh location against the work itself?"],
    },
    rubric: { strong: "answers practical questions honestly and professionally", weak: "evasive or unrealistic about practical constraints" },
    study: ["Research typical packages for the role", "Decide your relocation and joining constraints before interviewing"],
    unscored: true,
  }),
};

export interface CompetencySpec {
  id: string;
  required: boolean;
  weight: number;
}

const r = (id: string, weight = 1): CompetencySpec => ({ id, required: true, weight });
const o = (id: string, weight = 0.7): CompetencySpec => ({ id, required: false, weight });

export interface RoleFamilyDef {
  id: RoleFamily;
  label: string;
  /** Technical-round competencies. Empty = this family has no technical round. */
  technical: CompetencySpec[];
  /** HR-round competencies. */
  hr: CompetencySpec[];
  /** Default coding language when the candidate never picked one. */
  defaultLanguage: "java" | "python" | "cpp" | "javascript" | "c";
}

const HR_BASE: CompetencySpec[] = [r("communication", 1.2), r("ownership"), r("teamwork"), r("adaptability"), r("motivation"), o("self-awareness"), o("logistics", 0.3)];

export const ROLE_FAMILIES: Record<RoleFamily, RoleFamilyDef> = {
  sde: {
    id: "sde",
    label: "Software Development Engineer",
    technical: [r("projects"), r("dsa", 1.5), r("problem-solving", 1.5), r("cs-fundamentals"), o("oop"), o("system-design", 0.6)],
    hr: HR_BASE,
    defaultLanguage: "java",
  },
  fullstack: {
    id: "fullstack",
    label: "Full Stack Developer",
    technical: [r("projects"), r("frontend-ui"), r("backend-apis"), r("databases"), r("problem-solving"), o("web-fundamentals"), o("cloud-devops", 0.5)],
    hr: HR_BASE,
    defaultLanguage: "javascript",
  },
  frontend: {
    id: "frontend",
    label: "Frontend Developer",
    technical: [r("projects"), r("javascript", 1.3), r("frontend-ui", 1.3), r("web-fundamentals"), r("problem-solving"), o("testing-qa", 0.5)],
    hr: HR_BASE,
    defaultLanguage: "javascript",
  },
  backend: {
    id: "backend",
    label: "Backend Developer",
    technical: [r("projects"), r("backend-apis", 1.3), r("databases", 1.3), r("problem-solving"), r("system-design"), o("cloud-devops", 0.6)],
    hr: HR_BASE,
    defaultLanguage: "java",
  },
  java: {
    id: "java",
    label: "Java Developer",
    technical: [r("projects"), r("java", 1.5), r("oop"), r("dsa"), r("problem-solving"), o("databases"), o("backend-apis", 0.6)],
    hr: HR_BASE,
    defaultLanguage: "java",
  },
  python: {
    id: "python",
    label: "Python Developer",
    technical: [r("projects"), r("python", 1.5), r("dsa"), r("problem-solving"), o("oop"), o("databases", 0.6)],
    hr: HR_BASE,
    defaultLanguage: "python",
  },
  "data-analyst": {
    id: "data-analyst",
    label: "Data Analyst",
    technical: [r("projects"), r("databases", 1.3), r("data-analysis", 1.3), r("statistics"), r("visualization"), o("python", 0.6), o("problem-solving", 0.5)],
    hr: HR_BASE,
    defaultLanguage: "python",
  },
  devops: {
    id: "devops",
    label: "DevOps Engineer",
    technical: [r("projects"), r("cloud-devops", 1.5), r("networking-linux"), r("monitoring"), r("problem-solving"), o("system-design", 0.6)],
    hr: HR_BASE,
    defaultLanguage: "python",
  },
  qa: {
    id: "qa",
    label: "QA / Test Engineer",
    technical: [r("projects"), r("testing-qa", 1.5), r("automation"), r("problem-solving"), o("web-fundamentals", 0.6), o("databases", 0.5)],
    hr: HR_BASE,
    defaultLanguage: "java",
  },
  "ai-ml": {
    id: "ai-ml",
    label: "AI/ML Engineer",
    technical: [r("projects"), r("ml-fundamentals", 1.5), r("python"), r("statistics"), r("problem-solving"), o("ml-engineering", 0.8)],
    hr: HR_BASE,
    defaultLanguage: "python",
  },
  "hr-behavioural": {
    id: "hr-behavioural",
    label: "HR / Behavioural",
    technical: [],
    hr: [r("communication", 1.3), r("ownership"), r("teamwork"), r("adaptability"), r("self-awareness"), r("pressure"), r("motivation"), o("logistics", 0.3)],
    defaultLanguage: "java",
  },
};

/** Every role id the app accepts. The first three predate role families and
 * stay valid so stored sessions and old links keep working. */
export const ROLE_PRESETS = [
  "general",
  "java-sde-fresher",
  "frontend-fresher",
  "sde",
  "fullstack",
  "frontend",
  "backend",
  "java",
  "python",
  "data-analyst",
  "devops",
  "qa",
  "ai-ml",
  "hr-behavioural",
] as const;

/** The roles offered in the setup picker, in display order. */
export const PICKER_ROLES: RoleFamily[] = ["sde", "fullstack", "frontend", "backend", "java", "python", "data-analyst", "devops", "qa", "ai-ml", "hr-behavioural"];

export function familyOf(role: RolePreset | string): RoleFamily {
  switch (role) {
    case "general":
      return "sde";
    case "java-sde-fresher":
      return "java";
    case "frontend-fresher":
      return "frontend";
    default:
      return (role in ROLE_FAMILIES ? role : "sde") as RoleFamily;
  }
}

export function isRolePreset(v: unknown): v is RolePreset {
  return typeof v === "string" && (ROLE_PRESETS as readonly string[]).includes(v);
}

export function roleLabel(role: RolePreset | string): string {
  return ROLE_FAMILIES[familyOf(role)].label;
}

/** A behavioural-only family has no technical round to run. */
export function supportsTechnicalRound(role: RolePreset | string): boolean {
  return ROLE_FAMILIES[familyOf(role)].technical.length > 0;
}

export function competencyDef(id: string): CompetencyDef | undefined {
  return COMPETENCIES[id];
}

export function competencyLabel(id: string): string {
  return COMPETENCIES[id]?.label ?? id;
}
