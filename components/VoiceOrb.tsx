"use client";

import { useEffect, useRef } from "react";
import { vizState } from "@/lib/audio-viz";

// The voice orb — the room's centerpiece. A layered, audio-reactive blob:
// radius and glow ride the live level from lib/audio-viz (real mic amplitude
// while the candidate speaks; real playback amplitude for AudioContext
// engines; shaped envelope for speechSynthesis). Amber = interviewer,
// warm red = candidate, dim breath = idle/thinking.

const COLORS = {
  ai: { core: "232, 178, 100", glow: "224, 164, 88" },
  user: { core: "232, 122, 112", glow: "224, 112, 103" },
  idle: { core: "150, 150, 148", glow: "120, 120, 118" },
  thinking: { core: "200, 168, 120", glow: "180, 148, 100" },
} as const;

export function VoiceOrb({ size = 260 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
    let raf = 0;
    let smoothLevel = 0;
    let hue: { core: string; glow: string } = { ...COLORS.idle };
    const start = performance.now();

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const s = vizState();
      const target = COLORS[s.mode] ?? COLORS.idle;
      // Ease colors toward the mode (parse-free: keep rgb strings, lerp per channel)
      const lerp = (a: string, b: string) => {
        const pa = a.split(",").map(Number);
        const pb = b.split(",").map(Number);
        return pa.map((v, i) => Math.round(v + (pb[i] - v) * 0.08)).join(",");
      };
      hue = { core: lerp(hue.core, target.core), glow: lerp(hue.glow, target.glow) };

      const idleBreath = 0.06 * Math.sin(t * 1.1);
      smoothLevel += ((s.mode === "idle" ? 0 : s.level) - smoothLevel) * 0.18;
      const level = reduced ? smoothLevel * 0.5 : smoothLevel;

      const cx = size / 2;
      const cy = size / 2;
      const baseR = size * 0.26;
      const r = baseR * (1 + idleBreath + level * 0.45);

      ctx.clearRect(0, 0, size, size);

      // Outer glow halo
      const halo = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.2);
      halo.addColorStop(0, `rgba(${hue.glow}, ${0.28 + level * 0.35})`);
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);

      // Blob body: radius modulated by three drifting sine lobes (organic, not
      // a perfect circle — but subtle; this is a professional room, not a lava lamp)
      const lobes = reduced ? 0 : 1;
      ctx.beginPath();
      const STEPS = 90;
      for (let i = 0; i <= STEPS; i++) {
        const a = (i / STEPS) * Math.PI * 2;
        const wobble =
          lobes *
          r *
          0.05 *
          (Math.sin(a * 3 + t * 1.6) * 0.5 + Math.sin(a * 5 - t * 2.3) * 0.3 + Math.sin(a * 2 + t * 0.7) * 0.2) *
          (0.4 + level);
        const rr = r + wobble;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const body = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.1, cx, cy, r * 1.15);
      body.addColorStop(0, `rgba(${hue.core}, 0.95)`);
      body.addColorStop(0.55, `rgba(${hue.glow}, 0.55)`);
      body.addColorStop(1, `rgba(${hue.glow}, 0.06)`);
      ctx.fillStyle = body;
      ctx.fill();

      // Inner highlight ring
      ctx.beginPath();
      ctx.arc(cx, cy, r * (0.68 + level * 0.1), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 250, ${0.06 + level * 0.12})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden
    />
  );
}
