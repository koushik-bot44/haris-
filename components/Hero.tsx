"use client";

import { VoiceOrb } from "@/components/VoiceOrb";

// Landing hero — the signature idle voice orb over a soft porcelain glow, a
// display-serif promise, one primary CTA into the setup flow, and a compact
// three-item feature row. Styling lives entirely in globals.css.

const FEATURES = [
  {
    title: "Live voice interview",
    desc: "Spoken questions and adaptive deep-dives — you answer out loud, like the real room.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <path d="M12 18v3" />
      </svg>
    ),
  },
  {
    title: "Evidence-based scoring",
    desc: "A scorecard built from your own words — each criterion backed by what you actually said.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 11l2 2 4-4" />
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 3v-1M16 3v-1" />
      </svg>
    ),
  },
  {
    title: "Group discussion",
    desc: "Debate three AI candidates for airtime — the placement round no other tool simulates.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M8 10h8M8 13h5" />
        <path d="M4 5h16v11H9l-4 3v-3H4z" />
      </svg>
    ),
  },
];

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-inner">
        <div className="hero-orb">
          <VoiceOrb size={200} interactive />
        </div>
        <p className="eyebrow">
          <span className="dot" />
          Voice-first placement prep
        </p>
        <h1 id="hero-title" className="hero-title">
          Rehearse the real thing.
        </h1>
        <p className="hero-sub">
          A live voice interview with real feedback — spoken questions, adaptive deep-dives, and a
          scorecard built from your own words. Practise the rounds that decide placement day.
        </p>
        <div className="hero-cta">
          <a href="#setup" className="btn lg">
            Start practising
          </a>
          <a href="/dashboard" className="btn secondary lg">
            View dashboard
          </a>
        </div>
        <p className="hero-note">No login. Nothing uploaded. Your session stays on this device.</p>

        <div className="hero-features">
          {FEATURES.map((f) => (
            <div className="feature" key={f.title}>
              <span className="feature-icon">{f.icon}</span>
              <div className="feature-text">
                <span className="feature-title">{f.title}</span>
                <p className="feature-desc">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
