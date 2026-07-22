import { execFile } from "node:child_process";

// Shared headless-CLI runner for every claude-cli-backed capability
// (interviewer, scorer, GD debate). --strict-mcp-config is load-bearing:
// without it the CLI boots every globally-configured MCP server per call,
// measured at +17s of latency per turn.
//
// Model choice per call site: 'haiku' (default) for latency-critical turns,
// 'sonnet' for background work where quality beats speed (scoring, resume).

const DEFAULT_TIMEOUT_MS = 30_000;

// ENFORCEMENT BOUNDARY. Untrusted text (pasted resumes, transcripts) flows
// into these prompts, and the <<<...>>> prompt delimiters are guidance only —
// injected instructions could otherwise drive default-enabled tools to read
// local secrets (.env.local) into the reply. All our calls are pure text
// generation: --tools "" disables the entire built-in toolset, and the
// explicit deny list is a second lock should anything re-enable a tool.
const NO_TOOLS_ARGS = [
  "--tools",
  "",
  "--disallowedTools",
  "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Agent,TodoWrite",
];

export function runClaude(
  prompt: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  model: string = "haiku",
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--model", model, "--output-format", "text", "--strict-mcp-config", ...NO_TOOLS_ARGS],
      // `signal` kills the subprocess when the caller aborts (client disconnect).
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, signal },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
    // stdin EPIPE (binary missing / early exit) must reject, never crash the process.
    child.stdin?.on("error", reject);
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export function cliAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}
