"use client";

import { Component, type ReactNode } from "react";

// WebGL fails in more ways than a feature probe can predict: a driver the
// browser blocklists, a locked-down lab machine, a remote-desktop session, an
// exhausted context pool, a shader that will not compile on old integrated
// graphics. Any of those throws from inside <Canvas>, and React would take the
// whole page down with it.
//
// So the probe in VoiceOrb is only the first line: this catches the rest and
// swaps in the 2D orb. The interview is the product — it must never be lost to
// a decoration.

export class OrbBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onFail?: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Not a crash the user needs to see, but a developer should: it means this
    // machine silently dropped to the 2D orb.
    console.warn("[VoiceOrb] WebGL orb failed, using the 2D fallback:", error);
    // Let the host restyle around the 2D orb, which needs different chrome.
    this.props.onFail?.();
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
