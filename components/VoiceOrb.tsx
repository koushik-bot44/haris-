"use client";

import { useEffect, useRef } from "react";
import { vizState } from "@/lib/audio-viz";

// The voice orb — a soft, fluid gradient sphere on white (light studio
// language). Three blurred color fields drift inside a clipped circle; the
// live audio level (real mic amplitude for the candidate, real playback
// amplitude for AudioContext engines, shaped envelope for speechSynthesis)
// drives scale, drift speed, and saturation. Cool pastels = interviewer,
// warm pastels = candidate, near-grey breathing = idle.

type Mode = "idle" | "user" | "ai" | "thinking";

/** Hue families per mode (three internal color fields each). */
const HUES: Record<Mode, [number, number, number]> = {
  ai: [215, 165, 262], // sky, mint, lavender
  user: [18, 345, 42], // coral, rose, amber
  thinking: [220, 200, 240],
  idle: [220, 200, 240],
};

const SAT: Record<Mode, number> = { ai: 68, user: 70, thinking: 30, idle: 14 };

export function VoiceOrb({ size = 260, hue }: { size?: number; hue?: [number, number, number] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Ref, not effect dep — a persona hue array recreated per render must not
  // restart the canvas loop.
  const hueRef = useRef<[number, number, number] | undefined>(hue);
  hueRef.current = hue;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const blurOk = "filter" in ctx;
    let raf = 0;
    let smoothLevel = 0;
    let sat = SAT.idle;
    let hues: [number, number, number] = [...HUES.idle];
    const start = performance.now();

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const s = vizState();
      const mode = (s.mode in HUES ? s.mode : "idle") as Mode;

      // Ease level, saturation, and hues toward the current mode.
      smoothLevel += ((mode === "idle" ? 0 : s.level) - smoothLevel) * 0.16;
      const level = reduced ? smoothLevel * 0.5 : smoothLevel;
      sat += (SAT[mode] - sat) * 0.05;
      // "ai" tint priority: per-orb prop (GD persona orbs) > global utterance
      // hue (speak() opts.hue) > default family. Identical when both unset.
      const aiOverride = mode === "ai" ? (hueRef.current ?? s.aiHue) : null;
      const targetHues = aiOverride ?? HUES[mode];
      hues = hues.map((h, i) => {
        let d = targetHues[i] - h;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        return (h + d * 0.04 + 360) % 360;
      }) as [number, number, number];

      const cx = size / 2;
      const cy = size / 2;
      const breath = reduced ? 0 : 0.05 * Math.sin(t * 1.05);
      const pulse = mode === "thinking" && !reduced ? 0.04 * Math.sin(t * 3.2) : 0;
      const r = size * 0.3 * (1 + breath + pulse + level * 0.32);

      ctx.clearRect(0, 0, size, size);

      // Soft ground shadow — the sphere sits ON the page, not printed on it.
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy + r * 1.08, r * 0.72, r * 0.13, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(22, 22, 26, ${0.05 + level * 0.03})`;
      if (blurOk) ctx.filter = "blur(6px)";
      ctx.fill();
      ctx.restore();

      // Clip to the sphere and let three color fields drift inside it.
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();

      // Porcelain base so thin color reads as glaze, not smudge.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

      const speed = reduced ? 0.15 : 0.3 + level * 0.9;
      if (blurOk) ctx.filter = `blur(${Math.max(8, r * 0.28)}px)`;
      for (let i = 0; i < 3; i++) {
        const a = t * speed * (0.7 + i * 0.23) + (i * Math.PI * 2) / 3;
        const orbit = r * (0.34 + 0.1 * Math.sin(t * 0.6 + i * 2.1));
        const bx = cx + Math.cos(a) * orbit;
        const by = cy + Math.sin(a * 0.9 + i) * orbit;
        const br = r * (0.62 + 0.1 * Math.sin(t * 0.8 + i * 1.7) + level * 0.12);
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, `hsla(${hues[i]}, ${sat}%, 74%, ${0.85 + level * 0.15})`);
        g.addColorStop(1, `hsla(${hues[i]}, ${sat}%, 74%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();
      }
      if (blurOk) ctx.filter = "none";

      // Top-light: the quiet specular that makes it a sphere.
      const light = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.42, 0, cx - r * 0.3, cy - r * 0.42, r * 1.1);
      light.addColorStop(0, "rgba(255, 255, 255, 0.55)");
      light.addColorStop(0.5, "rgba(255, 255, 255, 0.08)");
      light.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = light;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.restore();

      // Hairline rim keeps the edge crisp on white.
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(22, 22, 26, ${0.07 + level * 0.05})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={canvasRef} style={{ width: size, height: size, display: "block" }} aria-hidden />;
}
