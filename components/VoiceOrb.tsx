"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { OrbBoundary } from "@/components/OrbBoundary";
import { VoiceOrbCanvas } from "@/components/VoiceOrbCanvas";
import { vizState } from "@/lib/audio-viz";

// three + fiber + drei is a large bundle and is useless on the server, so it
// loads only in the browser and only once we know WebGL actually works.
const Orb = dynamic(() => import("@/components/Orb").then((m) => m.Orb), { ssr: false });

/** Probed once per page load: some lab machines, locked-down laptops and
 * remote-desktop sessions have no usable WebGL at all.
 *
 * WebGL 2 specifically — three dropped WebGL 1 at r163, and the orb's shader
 * uses GLSL ES 3.00 only (texture(), the float[7](...) constructor). A WebGL 1
 * machine would pass a laxer probe and then fail inside the renderer. */
let webglOk: boolean | null = null;
function hasWebGL(): boolean {
  if (webglOk !== null) return webglOk;
  try {
    webglOk = Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    webglOk = false;
  }
  return webglOk;
}

// The voice orb — the ElevenLabs WebGL orb (components/Orb.tsx) driven by this
// app's audio bus. Cool colours = interviewer, warm = candidate, quiet
// blue-grey = idle; the same language the canvas orb used before it.
//
// Nothing here goes through React state. The shader reads three refs every
// frame — level in, level out, colours — and mode changes only ever mutate a
// ref, so a 60fps interview never re-renders a single component. That was the
// rule the old canvas orb followed and it still holds.
//
// Two volumes drive two different parts of the shader, so the routing matters:
//   uInputVolume  -> the white halo rings expand and brighten  ("you are heard")
//   uOutputVolume -> the ink churns faster and swirls harder   ("it is speaking")

type Mode = "idle" | "user" | "ai" | "thinking";

/** Hue families per mode — three hues each, carried over from the canvas orb so
 * the colour language did not change under the user's feet. */
const HUES: Record<Mode, [number, number, number]> = {
  ai: [215, 165, 262], // sky, mint, lavender
  user: [18, 345, 42], // coral, rose, amber
  // Thinking pulls violet, away from idle's blue-grey. The canvas orb gave
  // these two the same hues and told them apart with a pulse the WebGL orb has
  // no equivalent for, so without this "composing a question" and "waiting for
  // you to start" would look like the same state.
  thinking: [265, 240, 285],
  idle: [220, 200, 240],
};

// Idle and thinking sit higher than the canvas orb's 14/30: that orb had a rim
// and a ground shadow to hold its edge on white, and this one has neither — a
// near-grey orb would simply dissolve into the page.
const SAT: Record<Mode, number> = { ai: 66, user: 68, thinking: 48, idle: 32 };

/** The shader ramps black -> c1 -> c2 -> white across a luminance field, and
 * most of that field sits in the upper half. So BOTH stops have to stay pale:
 * ElevenLabs' own defaults are #CADCFC (L 89%) and #A0B9D1 (L 72%), and a stop
 * down at L 60% turns the orb into hard dark wedges instead of drifting smoke.
 * c1 is the bright, saturated highlight; c2 is the muted body beneath it.
 *
 * These render DARKER and more saturated than the hex you read here, and that
 * is deliberate. react-three-fiber turns on THREE.ColorManagement, so a Color
 * built from hex is converted sRGB -> linear, but the orb's shader writes
 * gl_FragColor with no re-encode, so the linear value is shown raw. ElevenLabs
 * authors against that same behaviour — it is why their pale #CADCFC shows up
 * as a confident blue. Do not "fix" it with LinearSRGBColorSpace: the colours
 * would render literally and the orb would wash out. Judge these values by the
 * pixels, never by the swatch. */
function palette(hues: [number, number, number], sat: number): [string, string] {
  return [
    hslToHex(hues[0], Math.min(92, sat + 24), 88),
    hslToHex(hues[1], Math.max(22, sat - 30), 72),
  ];
}

/** The driver loop runs at 60fps and the orb re-reads colorsRef every frame, so
 * neither side may allocate. Palettes come from a tiny fixed set of mode+hue
 * keys, so cache them and hand back the same array identity each time. */
const paletteCache = new Map<string, [string, string]>();
function cachedPalette(hues: [number, number, number], sat: number): [string, string] {
  const key = `${hues[0]},${hues[1]},${sat}`;
  let p = paletteCache.get(key);
  if (!p) {
    p = palette(hues, sat);
    paletteCache.set(key, p);
  }
  return p;
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => {
    const v = lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function VoiceOrb({
  size = 260,
  hue,
  interactive = false,
  paused = false,
}: {
  size?: number;
  hue?: [number, number, number];
  /** Landing-page only: the orb leans toward the pointer's presence so the hero
   * is alive before any audio exists. Off inside the rooms, where every bit of
   * motion should mean something about the conversation. */
  interactive?: boolean;
  /** Keep the orb mounted but idle. Lets a caller hide and re-show it without
   * paying to rebuild the WebGL context each time. */
  paused?: boolean;
}) {
  // Ref, not effect dep — a persona hue array recreated on every render must
  // not restart anything.
  const hueRef = useRef<[number, number, number] | undefined>(hue);
  hueRef.current = hue;

  const hostRef = useRef<HTMLDivElement>(null);
  const colorsRef = useRef<[string, string]>(palette(HUES.idle, SAT.idle));
  const pointerRef = useRef(0);

  // null until probed. Server and first client render agree on null (an empty
  // box), so there is no hydration mismatch; the orb fades in from zero opacity
  // anyway, which hides the one-frame swap.
  const [webgl, setWebgl] = useState<boolean | null>(null);
  useEffect(() => setWebgl(hasWebGL()), []);

  // An orb that has scrolled out of view still runs a full fragment shader
  // every frame. The landing page's orb sits above three screens of content, so
  // stop it once it leaves. Re-renders only on the crossing, never per frame.
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), {
      rootMargin: "120px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // One seed per mounted orb, so the interviewer's orb and a debater's orb do
  // not churn in lockstep.
  const seed = useMemo(() => Math.floor(Math.random() * 2 ** 32), []);

  // Set when the WebGL orb throws after the probe passed (a blocklisted driver,
  // a shader that will not compile). Either way we end up on the 2D orb, and it
  // wants the well out of the way.
  const [orbFailed, setOrbFailed] = useState(false);
  const is2d = webgl === false || orbFailed;

  // The well's rim scales with the orb so a 120px GD orb is not framed twice as
  // heavily as a 240px interview orb.
  const rim = Math.max(2, Math.round(size * 0.014));

  // Colour follows mode on its own rAF. The shader lerps toward whatever this
  // ref holds (0.08/frame), so a mode flip cross-fades instead of cutting.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = vizState();
      const mode = (s.mode in HUES ? s.mode : "idle") as Mode;
      // "ai" tint priority: per-orb prop (a GD persona) > the global per-
      // utterance hue set by speak() > the default family.
      const override = mode === "ai" ? (hueRef.current ?? s.aiHue) : null;
      colorsRef.current = cachedPalette(override ?? HUES[mode], SAT[mode]);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Slowing the shader's clock is not enough on its own: the loudest motion in
  // the orb is the halo pumping with the speaker's voice, and that comes from
  // here. Under reduced motion the levels are pulled most of the way back to
  // their resting values, so the orb still shifts with the conversation but
  // stops throbbing. Colour keeps carrying who is speaking.
  const calmRef = useRef(1);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      calmRef.current = mq.matches ? 0.35 : 1;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const damp = (rest: number, live: number) => rest + (live - rest) * calmRef.current;

  // Stable identities: the orb re-subscribes its effects whenever these change,
  // and they must not change.
  const getInputVolume = useCallback(() => {
    const s = vizState();
    if (s.mode === "user") return damp(0.3, s.level);
    if (s.mode === "ai") return 0.35; // keep the body full while it talks
    if (s.mode === "thinking") return 0.3;
    return damp(0.12, 0.12 + pointerRef.current * 0.35);
  }, []);

  const getOutputVolume = useCallback(() => {
    const s = vizState();
    if (s.mode === "ai") return damp(0.4, s.level);
    if (s.mode === "user") return 0.28; // calm body, loud rings
    if (s.mode === "thinking") return 0.5; // slow deliberate churn
    return damp(0.26, 0.26 + pointerRef.current * 0.3);
  }, []);

  // Pointer proximity -> a gentle swell, decaying back to rest. Cheap: one
  // window listener writing a number, no state, no layout reads per frame.
  useEffect(() => {
    if (!interactive) return;
    const el = hostRef.current;
    if (!el) return;
    let raf = 0;
    let target = 0;
    let px = 0;
    let py = 0;
    let seen = false;
    // The move handler only records coordinates. Measuring the orb lives in the
    // frame loop, so a fast pointer cannot force a layout read per event.
    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      seen = true;
    };
    const onLeave = () => {
      seen = false;
      target = 0;
    };
    const tick = () => {
      if (seen) {
        const r = el.getBoundingClientRect();
        const d = Math.hypot(px - (r.left + r.width / 2), py - (r.top + r.height / 2));
        target = Math.max(0, 1 - d / (r.width * 2.2));
      }
      pointerRef.current += (target - pointerRef.current) * 0.08;
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, [interactive]);

  return (
    <div
      ref={hostRef}
      className={`voice-orb${is2d ? " is-2d" : ""}`}
      style={{ width: size, height: size, "--orb-rim": `${rim}px` } as React.CSSProperties}
      aria-hidden
    >
      {/* The shader fills its disc edge-to-edge with no falloff, so the orb
          needs a rim to end against — the same recessed well ElevenLabs mounts
          it in. Without it the circle reads as clipped rather than placed. */}
      <div className="voice-orb-well">
        {webgl === false ? (
          <VoiceOrbCanvas size={size} hue={hue} paused={paused || !onScreen} />
        ) : webgl ? (
          <OrbBoundary
            onFail={() => setOrbFailed(true)}
            fallback={<VoiceOrbCanvas size={size} hue={hue} paused={paused || !onScreen} />}
          >
            <Orb
              seed={seed}
              colorsRef={colorsRef}
              volumeMode="manual"
              getInputVolume={getInputVolume}
              getOutputVolume={getOutputVolume}
              paused={paused || !onScreen}
              style={{ width: "100%", height: "100%" }}
            />
          </OrbBoundary>
        ) : null}
      </div>
    </div>
  );
}
