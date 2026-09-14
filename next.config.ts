import type { NextConfig } from "next";

// Security headers for every response. No Content-Security-Policy on purpose:
// the on-device models (huggingface.co, WASM, blob workers), the Monaco
// editor CDN and the Deepgram live socket each need allow-listing, and a CSP
// that silently breaks the mic or the editor in production is worse than
// none. Add one deliberately once those origins are pinned.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];

/** The on-device ML stack. It runs in the BROWSER only (lib/tts-kokoro.ts,
 * lib/stt-whisper.ts, both behind `typeof window` guards) and must not exist in
 * the server build at all — see the webpack hook for why "external" was not
 * enough. */
const BROWSER_ONLY_ML = ["kokoro-js", "@huggingface/transformers", "phonemizer", "onnxruntime-node", "onnxruntime-web"];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // The browser build resolves onnxruntime-web through package exports;
      // the native Node binding has no business in a client chunk.
      config.resolve.alias = {
        ...config.resolve.alias,
        "onnxruntime-node": false,
      };
    } else {
      // Stub the ML stack out of the SERVER build with empty modules.
      //
      // This used to be `serverExternalPackages`, which only tells webpack
      // "require these from node_modules at runtime instead of bundling them".
      // That left a live require of kokoro-js in the server bundles of every
      // page that imports lib/tts (app/page, /interview, /gd), and Next
      // preloads those bundles at `next start` — so the NATIVE onnxruntime
      // binding was loaded into the server process at boot, before a single
      // request ("The requested API version [24] is not available … ORT
      // Version is: 1.21.0" on every startup). Two consequences, both measured:
      //   * kokoro-js's dependency `phonemizer` is Emscripten glue, and when it
      //     is evaluated in Node it installs
      //       process.on("uncaughtException", e => { throw e })
      //     Next.js tolerates a client aborting a streamed turn (it logs the
      //     ECONNRESET on the request and carries on) — until that handler
      //     rethrows inside the handler chain and the process exits (code 7;
      //     on Windows a libuv assertion fires on the way down). One candidate
      //     closing a tab mid-answer killed every concurrent interview;
      //   * the pages' .nft.json traces listed the packages, so a Vercel deploy
      //     would ship the native binaries inside the page lambdas for no reason.
      // An empty module cannot be loaded at boot and cannot be traced. The
      // dynamic imports in the two client modules never run on the server, so
      // nothing observable changes there.
      //
      // Why an EXTERNALS handler and not a resolve alias: Next ships its own
      // default external list (node_modules/next/dist/lib/server-external-
      // packages.json) that already names @huggingface/transformers and
      // onnxruntime-node, and webpack consults externals BEFORE it resolves
      // aliases. An alias therefore stubbed kokoro-js/phonemizer but left the
      // whisper path (lib/stt-whisper.ts → @huggingface/transformers → the
      // onnxruntime-node binaries, plus sharp) traced into /interview and /gd:
      // 127 MB per function, measured. Externals are evaluated in order and
      // the first answer wins, so ours goes first.
      const stubMl = (
        { request }: { request?: string },
        callback: (err?: Error | null, result?: string, type?: string) => void,
      ) => {
        if (request && BROWSER_ONLY_ML.some((m) => request === m || request.startsWith(`${m}/`))) {
          return callback(null, "{}", "var"); // module.exports = {}
        }
        return callback();
      };
      const existing = config.externals;
      config.externals = [stubMl, ...(Array.isArray(existing) ? existing : existing ? [existing] : [])];
    }
    // kokoro-js's bundled transformers build reads `import.meta` in a way
    // webpack cannot statically analyse; it works at runtime. Silence the
    // "Critical dependency" warning so real warnings stay visible.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /@huggingface\/transformers/, message: /import\.meta/ },
    ];
    return config;
  },
};

export default nextConfig;
