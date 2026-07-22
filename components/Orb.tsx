"use client";

// The ElevenLabs UI orb — a WebGL/GLSL "liquid ink" sphere, vendored from
// https://github.com/elevenlabs/ui (MIT, registry/elevenlabs-ui/ui/orb.tsx).
//
// The GLSL is byte-identical to upstream so future releases can be diffed
// mechanically. Everything that differs is in the React layer and is marked
// LOCAL: at the site, in four groups —
//   * assets and platform: the perlin texture is vendored at /perlin-noise.png
//     rather than fetched from their CDN, and preloading is guarded for SSR
//   * no Tailwind (this app has none): the wrapper is styled inline
//   * accessibility and cost: prefers-reduced-motion, a device-pixel-ratio cap,
//     a delta clamp for backgrounded tabs, and a `paused` prop
//   * correctness fixes: colours are only re-parsed when they change, a
//     supplied colorsRef is the sole authority for the colour target, and the
//     default colour pair is hoisted so it keeps a stable identity
//
// The disc is fully OPAQUE — alpha is 1.0 everywhere inside the circle, and
// never falls off at the rim. What makes the edge disappear is the colour ramp
// (black -> uColor1 -> uColor2 -> white) resolving to white, so it only blends
// on a white surface, and only there. That is why VoiceOrb mounts it in a well
// with a rim: on anything else you would see a cut circle.
//
// Drive it from the app via VoiceOrb, not directly.

import { useEffect, useMemo, useRef } from "react";
import { useTexture } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

export type AgentState = null | "thinking" | "listening" | "talking";

/** LOCAL: hoisted out of the default parameter. As an inline literal it was a
 * new array on every render, which re-fired the colour effect endlessly. */
const DEFAULT_COLORS: [string, string] = ["#CADCFC", "#A0B9D1"];

type OrbProps = {
  colors?: [string, string];
  colorsRef?: React.RefObject<[string, string]>;
  resizeDebounce?: number;
  seed?: number;
  agentState?: AgentState;
  volumeMode?: "auto" | "manual";
  manualInput?: number;
  manualOutput?: number;
  inputVolumeRef?: React.RefObject<number>;
  outputVolumeRef?: React.RefObject<number>;
  getInputVolume?: () => number;
  getOutputVolume?: () => number;
  className?: string;
  style?: React.CSSProperties;
  /** LOCAL: stop rendering without unmounting. Lets a caller keep one orb alive
   * across state changes instead of paying for a new WebGL context and a
   * fragment-shader recompile each time. */
  paused?: boolean;
};

/** LOCAL: the texture is a static app asset — warm it before first paint so the
 * orb does not pop in on the very first mount of a session. Browser only:
 * three's ImageLoader reaches for document, which does not exist on the server.
 * VoiceOrb already imports this file with ssr:false; this guard is for anyone
 * who imports Orb directly later. */
if (typeof document !== "undefined") {
  useTexture.preload("/perlin-noise.png");
}

export function Orb({
  colors = DEFAULT_COLORS,
  colorsRef,
  // LOCAL: upstream hardcodes 100 here, which is worse than passing nothing.
  // r3f already defaults to { scroll: 50, resize: 0 } — resize is measured
  // immediately and only scroll is debounced. A scalar collapses both: 100
  // leaves a fixed-size orb at 0x0 for the first 100ms, and 0 re-measures on
  // every scroll event, which is a re-render loop. Undefined keeps r3f's
  // defaults; pass a number only if you actually need to override them.
  resizeDebounce,
  seed,
  agentState = null,
  volumeMode = "auto",
  manualInput,
  manualOutput,
  inputVolumeRef,
  outputVolumeRef,
  getInputVolume,
  getOutputVolume,
  className,
  style,
  paused = false,
}: OrbProps) {
  return (
    // LOCAL: upstream defaults to Tailwind's "relative h-full w-full". The
    // <Canvas> measures this box, so it must have a real size — callers pass
    // one via `style`.
    <div
      className={className}
      style={{ position: "relative", width: "100%", height: "100%", ...style }}
    >
      <Canvas
        resize={resizeDebounce === undefined ? undefined : { debounce: resizeDebounce }}
        // LOCAL: cap the device pixel ratio so retina panels keep 60fps.
        dpr={[1, 2]}
        // LOCAL: see the `paused` prop.
        frameloop={paused ? "demand" : "always"}
        gl={{
          alpha: true,
          antialias: true,
          // Straight-alpha blending writes src.rgb*src.a into the buffer, so
          // what reaches the compositor IS premultiplied. Upstream's true is
          // right; flipping it to false double-darkens the fade-in.
          premultipliedAlpha: true,
        }}
      >
        <Scene
          colors={colors}
          colorsRef={colorsRef}
          seed={seed}
          agentState={agentState}
          volumeMode={volumeMode}
          manualInput={manualInput}
          manualOutput={manualOutput}
          inputVolumeRef={inputVolumeRef}
          outputVolumeRef={outputVolumeRef}
          getInputVolume={getInputVolume}
          getOutputVolume={getOutputVolume}
        />
      </Canvas>
    </div>
  );
}

function Scene({
  colors,
  colorsRef,
  seed,
  agentState,
  volumeMode,
  manualInput,
  manualOutput,
  inputVolumeRef,
  outputVolumeRef,
  getInputVolume,
  getOutputVolume,
}: {
  colors: [string, string];
  colorsRef?: React.RefObject<[string, string]>;
  seed?: number;
  agentState: AgentState;
  volumeMode: "auto" | "manual";
  manualInput?: number;
  manualOutput?: number;
  inputVolumeRef?: React.RefObject<number>;
  outputVolumeRef?: React.RefObject<number>;
  getInputVolume?: () => number;
  getOutputVolume?: () => number;
}) {
  const { gl } = useThree();
  const circleRef = useRef<THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>>(null);
  const initialColorsRef = useRef<[string, string]>(colors);
  const targetColor1Ref = useRef(new THREE.Color(colors[0]));
  const targetColor2Ref = useRef(new THREE.Color(colors[1]));
  const lastColor1Ref = useRef<string | null>(null);
  const lastColor2Ref = useRef<string | null>(null);
  const animSpeedRef = useRef(0.1);
  // LOCAL: vendored asset instead of the eleven-public-cdn URL, so the orb
  // still renders with no network (a live demo must not depend on a CDN).
  const perlinNoiseTexture = useTexture("/perlin-noise.png");

  const agentRef = useRef<AgentState>(agentState);
  const modeRef = useRef<"auto" | "manual">(volumeMode);
  const manualInRef = useRef<number>(manualInput ?? 0);
  const manualOutRef = useRef<number>(manualOutput ?? 0);
  const curInRef = useRef(0);
  const curOutRef = useRef(0);
  // LOCAL: motion budget — 1 normally, 0.35 when the OS asks for less motion.
  const motionRef = useRef(1);

  useEffect(() => {
    agentRef.current = agentState;
  }, [agentState]);

  useEffect(() => {
    modeRef.current = volumeMode;
  }, [volumeMode]);

  useEffect(() => {
    manualInRef.current = clamp01(manualInput ?? inputVolumeRef?.current ?? getInputVolume?.() ?? 0);
  }, [manualInput, inputVolumeRef, getInputVolume]);

  useEffect(() => {
    manualOutRef.current = clamp01(
      manualOutput ?? outputVolumeRef?.current ?? getOutputVolume?.() ?? 0
    );
  }, [manualOutput, outputVolumeRef, getOutputVolume]);

  // LOCAL: honour prefers-reduced-motion, and keep honouring it if the user
  // flips the OS setting mid-session.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      motionRef.current = mq.matches ? 0.35 : 1;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const random = useMemo(() => splitmix32(seed ?? Math.floor(Math.random() * 2 ** 32)), [seed]);
  const offsets = useMemo(
    () => new Float32Array(Array.from({ length: 7 }, () => random() * Math.PI * 2)),
    [random]
  );

  // LOCAL: when a colorsRef is supplied it is the authority and useFrame owns
  // the targets. Upstream let this effect clobber them anyway, which was
  // invisible there only because upstream re-applied colorsRef every single
  // frame. It re-fires on any parent re-render, because the default `colors`
  // is a fresh array literal each time — so without this guard the orb resets
  // to the stock ElevenLabs blue the first time VoiceOrb re-renders (a scroll
  // crossing, a paused flip) and every mode colour is lost for good.
  useEffect(() => {
    // Belt and braces: if this ever does rebuild the targets, drop the parse
    // cache too, so the next frame re-applies the live colour instead of
    // deciding it is already correct.
    lastColor1Ref.current = null;
    lastColor2Ref.current = null;
    if (colorsRef) return;
    targetColor1Ref.current = new THREE.Color(colors[0]);
    targetColor2Ref.current = new THREE.Color(colors[1]);
  }, [colors, colorsRef]);

  useEffect(() => {
    const apply = () => {
      if (!circleRef.current) return;
      const isDark = document.documentElement.classList.contains("dark");
      circleRef.current.material.uniforms.uInverted.value = isDark ? 1 : 0;
    };

    apply();

    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useFrame((_, rawDelta: number) => {
    const mat = circleRef.current?.material;
    if (!mat) return;
    // LOCAL: clamp delta so a backgrounded tab does not jump the animation on
    // return, then scale it by the reduced-motion budget.
    const delta = Math.min(rawDelta, 1 / 30) * motionRef.current;
    // LOCAL: upstream re-parses both hex strings every frame. Color.set on a
    // string runs three's regex style parser, so that is four regex parses per
    // orb per frame, forever, to produce the same two colours. Only parse when
    // the string actually changes.
    const live = colorsRef?.current;
    if (live) {
      if (live[0] && live[0] !== lastColor1Ref.current) {
        lastColor1Ref.current = live[0];
        targetColor1Ref.current.set(live[0]);
      }
      if (live[1] && live[1] !== lastColor2Ref.current) {
        lastColor2Ref.current = live[1];
        targetColor2Ref.current.set(live[1]);
      }
    }
    const u = mat.uniforms;
    u.uTime.value += delta * 0.5;

    if (u.uOpacity.value < 1) {
      u.uOpacity.value = Math.min(1, u.uOpacity.value + delta * 2);
    }

    let targetIn = 0;
    let targetOut = 0.3;
    if (modeRef.current === "manual") {
      targetIn = clamp01(manualInput ?? inputVolumeRef?.current ?? getInputVolume?.() ?? 0);
      targetOut = clamp01(manualOutput ?? outputVolumeRef?.current ?? getOutputVolume?.() ?? 0);
    } else {
      const t = u.uTime.value * 2;
      if (agentRef.current === null) {
        targetIn = 0;
        targetOut = 0.3;
      } else if (agentRef.current === "listening") {
        targetIn = clamp01(0.55 + Math.sin(t * 3.2) * 0.35);
        targetOut = 0.45;
      } else if (agentRef.current === "talking") {
        targetIn = clamp01(0.65 + Math.sin(t * 4.8) * 0.22);
        targetOut = clamp01(0.75 + Math.sin(t * 3.6) * 0.22);
      } else {
        const base = 0.38 + 0.07 * Math.sin(t * 0.7);
        const wander = 0.05 * Math.sin(t * 2.1) * Math.sin(t * 0.37 + 1.2);
        targetIn = clamp01(base + wander);
        targetOut = clamp01(0.48 + 0.12 * Math.sin(t * 1.05 + 0.6));
      }
    }

    curInRef.current += (targetIn - curInRef.current) * 0.2;
    curOutRef.current += (targetOut - curOutRef.current) * 0.2;

    const targetSpeed = 0.1 + (1 - Math.pow(curOutRef.current - 1, 2)) * 0.9;
    animSpeedRef.current += (targetSpeed - animSpeedRef.current) * 0.12;

    u.uAnimation.value += delta * animSpeedRef.current;
    u.uInputVolume.value = curInRef.current;
    u.uOutputVolume.value = curOutRef.current;
    u.uColor1.value.lerp(targetColor1Ref.current, 0.08);
    u.uColor2.value.lerp(targetColor2Ref.current, 0.08);
  });

  useEffect(() => {
    const canvas = gl.domElement;
    const onContextLost = (event: Event) => {
      event.preventDefault();
      setTimeout(() => {
        gl.forceContextRestore();
      }, 1);
    };
    canvas.addEventListener("webglcontextlost", onContextLost, false);
    return () => canvas.removeEventListener("webglcontextlost", onContextLost, false);
  }, [gl]);

  const uniforms = useMemo(() => {
    perlinNoiseTexture.wrapS = THREE.RepeatWrapping;
    perlinNoiseTexture.wrapT = THREE.RepeatWrapping;
    const isDark =
      typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    return {
      uColor1: new THREE.Uniform(new THREE.Color(initialColorsRef.current[0])),
      uColor2: new THREE.Uniform(new THREE.Color(initialColorsRef.current[1])),
      uOffsets: { value: offsets },
      uPerlinTexture: new THREE.Uniform(perlinNoiseTexture),
      uTime: new THREE.Uniform(0),
      uAnimation: new THREE.Uniform(0.1),
      uInverted: new THREE.Uniform(isDark ? 1 : 0),
      uInputVolume: new THREE.Uniform(0),
      uOutputVolume: new THREE.Uniform(0),
      uOpacity: new THREE.Uniform(0),
    };
  }, [perlinNoiseTexture, offsets]);

  return (
    <mesh ref={circleRef}>
      <circleGeometry args={[3.5, 64]} />
      <shaderMaterial
        uniforms={uniforms}
        fragmentShader={fragmentShader}
        vertexShader={vertexShader}
        transparent={true}
      />
    </mesh>
  );
}

function splitmix32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

const vertexShader = /* glsl */ `
uniform float uTime;
uniform sampler2D uPerlinTexture;
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform float uTime;
uniform float uAnimation;
uniform float uInverted;
uniform float uOffsets[7];
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform float uInputVolume;
uniform float uOutputVolume;
uniform float uOpacity;
uniform sampler2D uPerlinTexture;
varying vec2 vUv;

const float PI = 3.14159265358979323846;

// Draw a single oval with soft edges and calculate its gradient color
bool drawOval(vec2 polarUv, vec2 polarCenter, float a, float b, bool reverseGradient, float softness, out vec4 color) {
    vec2 p = polarUv - polarCenter;
    float oval = (p.x * p.x) / (a * a) + (p.y * p.y) / (b * b);

    float edge = smoothstep(1.0, 1.0 - softness, oval);

    if (edge > 0.0) {
        float gradient = reverseGradient ? (1.0 - (p.x / a + 1.0) / 2.0) : ((p.x / a + 1.0) / 2.0);
        // Flatten gradient toward middle value for more uniform appearance
        gradient = mix(0.5, gradient, 0.1);
        color = vec4(vec3(gradient), 0.85 * edge);
        return true;
    }
    return false;
}

// Map grayscale value to a 4-color ramp (color1, color2, color3, color4)
vec3 colorRamp(float grayscale, vec3 color1, vec3 color2, vec3 color3, vec3 color4) {
    if (grayscale < 0.33) {
        return mix(color1, color2, grayscale * 3.0);
    } else if (grayscale < 0.66) {
        return mix(color2, color3, (grayscale - 0.33) * 3.0);
    } else {
        return mix(color3, color4, (grayscale - 0.66) * 3.0);
    }
}

vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

// 2D noise for the ring
float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);

    vec2 u = f * f * (3.0 - 2.0 * f);
    float n = mix(
        mix(dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
            dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
        mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
            dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
        u.y
    );

    return 0.5 + 0.5 * n;
}

float sharpRing(vec3 decomposed, float time) {
    float ringStart = 1.0;
    float ringWidth = 0.3;
    float noiseScale = 5.0;

    float noise = mix(
        noise2D(vec2(decomposed.x, time) * noiseScale),
        noise2D(vec2(decomposed.y, time) * noiseScale),
        decomposed.z
    );

    noise = (noise - 0.5) * 2.5;

    return ringStart + noise * ringWidth * 1.5;
}

float smoothRing(vec3 decomposed, float time) {
    float ringStart = 0.9;
    float ringWidth = 0.2;
    float noiseScale = 6.0;

    float noise = mix(
        noise2D(vec2(decomposed.x, time) * noiseScale),
        noise2D(vec2(decomposed.y, time) * noiseScale),
        decomposed.z
    );

    noise = (noise - 0.5) * 5.0;

    return ringStart + noise * ringWidth;
}

float flow(vec3 decomposed, float time) {
    return mix(
        texture(uPerlinTexture, vec2(time, decomposed.x / 2.0)).r,
        texture(uPerlinTexture, vec2(time, decomposed.y / 2.0)).r,
        decomposed.z
    );
}

void main() {
    // Normalize vUv to be centered around (0.0, 0.0)
    vec2 uv = vUv * 2.0 - 1.0;

    // Convert uv to polar coordinates
    float radius = length(uv);
    float theta = atan(uv.y, uv.x);
    if (theta < 0.0) theta += 2.0 * PI; // Normalize theta to [0, 2*PI]

    // Decomposed angle is used for sampling noise textures without seams:
    // float noise = mix(sample(decomposed.x), sample(decomposed.y), decomposed.z);
    vec3 decomposed = vec3(
        // angle in the range [0, 1]
        theta / (2.0 * PI),
        // angle offset by 180 degrees in the range [1, 2]
        mod(theta / (2.0 * PI) + 0.5, 1.0) + 1.0,
        // mixing factor between two noises
        abs(theta / PI - 1.0)
    );

    // Add noise to the angle for a flow-like distortion (reduced for flatter look)
    float noise = flow(decomposed, radius * 0.03 - uAnimation * 0.2) - 0.5;
    theta += noise * mix(0.08, 0.25, uOutputVolume);

    // Initialize the base color to white
    vec4 color = vec4(1.0, 1.0, 1.0, 1.0);

    // Original parameters for the ovals in polar coordinates
    float originalCenters[7] = float[7](0.0, 0.5 * PI, 1.0 * PI, 1.5 * PI, 2.0 * PI, 2.5 * PI, 3.0 * PI);

    // Parameters for the animated centers in polar coordinates
    float centers[7];
    for (int i = 0; i < 7; i++) {
        centers[i] = originalCenters[i] + 0.5 * sin(uTime / 20.0 + uOffsets[i]);
    }

    float a, b;
    vec4 ovalColor;

    // Check if the pixel is inside any of the ovals
    for (int i = 0; i < 7; i++) {
        float noise = texture(uPerlinTexture, vec2(mod(centers[i] + uTime * 0.05, 1.0), 0.5)).r;
        a = 0.5 + noise * 0.3; // Increased for more coverage
        b = noise * mix(3.5, 2.5, uInputVolume); // Increased height for fuller appearance
        bool reverseGradient = (i % 2 == 1); // Reverse gradient for every second oval

        // Calculate the distance in polar coordinates
        float distTheta = min(
            abs(theta - centers[i]),
            min(
                abs(theta + 2.0 * PI - centers[i]),
                abs(theta - 2.0 * PI - centers[i])
            )
        );
        float distRadius = radius;

        float softness = 0.6; // Increased softness for flatter, less pronounced edges

        // Check if the pixel is inside the oval in polar coordinates
        if (drawOval(vec2(distTheta, distRadius), vec2(0.0, 0.0), a, b, reverseGradient, softness, ovalColor)) {
            // Blend the oval color with the existing color
            color.rgb = mix(color.rgb, ovalColor.rgb, ovalColor.a);
            color.a = max(color.a, ovalColor.a); // Max alpha
        }
    }

    // Calculate both noisy rings
    float ringRadius1 = sharpRing(decomposed, uTime * 0.1);
    float ringRadius2 = smoothRing(decomposed, uTime * 0.1);

    // Adjust rings based on input volume (reduced for flatter appearance)
    float inputRadius1 = radius + uInputVolume * 0.2;
    float inputRadius2 = radius + uInputVolume * 0.15;
    float opacity1 = mix(0.2, 0.6, uInputVolume);
    float opacity2 = mix(0.15, 0.45, uInputVolume);

    // Blend both rings
    float ringAlpha1 = (inputRadius2 >= ringRadius1) ? opacity1 : 0.0;
    float ringAlpha2 = smoothstep(ringRadius2 - 0.05, ringRadius2 + 0.05, inputRadius1) * opacity2;

    float totalRingAlpha = max(ringAlpha1, ringAlpha2);

    // Apply screen blend mode for combined rings
    vec3 ringColor = vec3(1.0); // White ring color
    color.rgb = 1.0 - (1.0 - color.rgb) * (1.0 - ringColor * totalRingAlpha);

    // Define colours to ramp against greyscale (could increase the amount of colours in the ramp)
    vec3 color1 = vec3(0.0, 0.0, 0.0); // Black
    vec3 color2 = uColor1; // Darker Color
    vec3 color3 = uColor2; // Lighter Color
    vec3 color4 = vec3(1.0, 1.0, 1.0); // White

    // Convert grayscale color to the color ramp
    float luminance = mix(color.r, 1.0 - color.r, uInverted);
    color.rgb = colorRamp(luminance, color1, color2, color3, color4); // Apply the color ramp

    // Apply fade-in opacity
    color.a *= uOpacity;

    gl_FragColor = color;
}
`;
