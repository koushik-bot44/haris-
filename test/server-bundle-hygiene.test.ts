import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The on-device ML stack must never reach the SERVER build. It did once, and
// the consequences were measured on 2026-08-25:
//   * kokoro-js pulls in phonemizer, whose Emscripten glue installs
//     process.on("uncaughtException", e => { throw e }) when evaluated in Node.
//     Next tolerates a client aborting a streamed turn (it logs the ECONNRESET
//     and carries on) — until that handler rethrows inside the handler chain
//     and the whole server exits (code 7). One closed tab took down every
//     concurrent interview.
//   * The pages' Node file traces (.nft.json) listed the packages, so the
//     /interview and /gd Vercel functions weighed 220 MB each — 210 MB of
//     onnxruntime-node binaries for every OS — against a 250 MB limit.
// next.config.ts now stubs the packages out of the server build with empty
// modules. This test reads the build output and refuses to let them back in.
//
// It needs a build to inspect, so it is skipped when .next/server is absent
// (a fresh checkout running `vitest` before `next build`); `npm run check`
// and any machine that has built at least once exercise it.

const ROOT = join(__dirname, "..");
const SERVER_DIR = join(ROOT, ".next", "server", "app");
const BANNED = ["kokoro-js", "@huggingface/transformers", "phonemizer", "onnxruntime-node", "onnxruntime-web"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const hasBuild = existsSync(SERVER_DIR);

describe.skipIf(!hasBuild)("server bundle hygiene — the browser ML stack stays out of the server", () => {
  const files = hasBuild ? walk(SERVER_DIR) : [];
  // Only `next build` writes file traces; a `next dev` output dir has the
  // server chunks (checked below) but no .nft.json to inspect.
  const traces = files.filter((f) => f.endsWith(".nft.json"));

  it.skipIf(traces.length === 0)("no page or route function traces a browser-only ML package", () => {
    expect(traces.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of traces) {
      const listed = (JSON.parse(readFileSync(f, "utf8")) as { files?: string[] }).files ?? [];
      for (const dep of listed) {
        const norm = dep.replace(/\\/g, "/");
        const hit = BANNED.find((b) => norm.includes(`node_modules/${b}/`));
        if (hit) offenders.push(`${f.slice(ROOT.length + 1)} -> ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no server chunk contains a live require/import of a browser-only ML package", () => {
    const chunks = files.filter((f) => f.endsWith(".js"));
    const offenders: string[] = [];
    for (const f of chunks) {
      const src = readFileSync(f, "utf8");
      for (const b of BANNED) {
        // A stubbed package leaves no request string behind at all; a real
        // one appears as require("kokoro-js") / import("kokoro-js").
        if (new RegExp(`(require|import)\\(\\s*["']${b.replace(/[/@.-]/g, "\\$&")}["']`).test(src)) {
          offenders.push(`${f.slice(ROOT.length + 1)} -> ${b}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
