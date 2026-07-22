import { spawn } from "node:child_process";

// Shared headless-CLI runner for every claude-cli-backed capability
// (interviewer, scorer, GD debate). --strict-mcp-config is load-bearing:
// without it the CLI boots every globally-configured MCP server per call,
// measured at +17s of latency per turn.
//
// Model choice per call site: 'haiku' (default) for latency-critical turns,
// 'sonnet' for background work where quality beats speed (scoring, resume).
//
// Spawn (not execFile) so stdout streams: onChunk fires per raw chunk as it
// arrives — the interview route forwards partial text to the client while the
// model is still generating. The resolved value stays the full stdout.

const DEFAULT_TIMEOUT_MS = 30_000;
/** execFile's old maxBuffer, enforced by hand under spawn. */
const MAX_STDOUT_BYTES = 1024 * 1024;

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

/** Extract text deltas + the final result from one stream-json NDJSON line.
 * `claude -p --output-format text` flushes its whole reply in ONE chunk, so
 * true typing-effect streaming requires stream-json + partial messages. */
function streamJsonDelta(line: string): { delta?: string; result?: string } {
  try {
    const j = JSON.parse(line) as {
      type?: string;
      event?: { type?: string; delta?: { type?: string; text?: string } };
      result?: string;
    };
    if (j.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.type === "text_delta") {
      return { delta: j.event.delta.text ?? "" };
    }
    if (j.type === "result" && typeof j.result === "string") return { result: j.result };
  } catch {
    // non-JSON noise line — ignore
  }
  return {};
}

export function runClaude(
  prompt: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  model: string = "haiku",
  signal?: AbortSignal,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  // Streaming callers get stream-json (token-level deltas); plain callers keep
  // text mode (smaller output, same result).
  const formatArgs = onChunk
    ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    : ["--output-format", "text"];
  return new Promise((resolve, reject) => {
    // `signal` kills the subprocess when the caller aborts (client disconnect).
    const child = spawn(
      "claude",
      ["-p", "--model", model, ...formatArgs, "--strict-mcp-config", ...NO_TOOLS_ARGS],
      { signal },
    );
    let out = "";
    let streamed = "";
    let finalResult: string | null = null;
    let lineBuf = "";
    let bytes = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => {
      fail(new Error(`claude-cli timeout after ${timeoutMs}ms`));
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", fail); // spawn failure (binary missing) and signal abort
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_STDOUT_BYTES) {
        fail(new Error("claude-cli stdout exceeded maxBuffer"));
        child.kill("SIGTERM");
        return;
      }
      out += chunk;
      if (settled) return;
      if (!onChunk) return;
      // stream-json: parse per line, forward text deltas as they arrive.
      lineBuf += chunk;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        const { delta, result } = streamJsonDelta(line);
        if (delta) {
          streamed += delta;
          onChunk(delta);
        }
        if (result !== null && result !== undefined) finalResult = result;
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timer);
        // Streaming mode resolves the model's text (result event, else the
        // accumulated deltas); text mode resolves raw stdout as before.
        resolve(onChunk ? (finalResult ?? streamed) : out);
      } else {
        fail(new Error(`claude-cli exited with code ${code}`));
      }
    });
    // stdin EPIPE (binary missing / early exit) must reject, never crash the process.
    child.stdin.on("error", fail);
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function cliAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}
