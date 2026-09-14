"use client";

import { useEffect } from "react";

// Route-level error boundary: a thrown render/effect error shows a way back
// instead of a blank page. The interview room's own state survives in the
// hook; "Try again" re-renders the segment.

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[ui] route error:", error);
  }, [error]);
  return (
    <main className="wrap">
      <section className="card panel-enter" role="alert">
        <h2>Something went wrong</h2>
        <p className="muted">
          The page hit an error it couldn't recover from. Your saved rounds are safe — they live on this device.
        </p>
        {error.digest && (
          <p className="small muted">
            reference: <code>{error.digest}</code>
          </p>
        )}
        <div className="inline-actions">
          <button className="btn" onClick={reset}>
            Try again
          </button>
          <a className="btn secondary" href="/">
            Back to setup
          </a>
        </div>
      </section>
    </main>
  );
}
