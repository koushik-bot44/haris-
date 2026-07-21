import { execFile } from "node:child_process";

// Shared headless-CLI runner for every claude-cli-backed capability
// (interviewer, scorer, GD debate). --strict-mcp-config is load-bearing:
// without it the CLI boots every globally-configured MCP server per call,
// measured at +17s of latency per turn.

const DEFAULT_TIMEOUT_MS = 30_000;

export function runClaude(prompt: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--model", "haiku", "--output-format", "text", "--strict-mcp-config"],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export function cliAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}
