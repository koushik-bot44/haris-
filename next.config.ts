import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The on-device ML stack (Whisper STT, Kokoro TTS) runs in the BROWSER via
  // dynamic import. Keep it out of the server bundle entirely, and stub the
  // native Node onnxruntime binding out of client bundles (the browser build
  // resolves onnxruntime-web through package exports instead).
  serverExternalPackages: ["@huggingface/transformers", "kokoro-js", "onnxruntime-node"],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "onnxruntime-node": false,
      };
    }
    return config;
  },
};

export default nextConfig;
