"use client";

// Primary navigation lives in the global AppHeader (app/layout.tsx) — this
// file keeps only the shared empty-state card.
export function EmptyState({
  message,
  cta = "Start an HR round",
  href = "/",
}: {
  message: string;
  cta?: string;
  href?: string;
}) {
  return (
    <div className="card tinted" style={{ textAlign: "left" }}>
      <p style={{ marginTop: 0 }}>{message}</p>
      <a className="btn" href={href} style={{ textDecoration: "none" }}>
        {cta}
      </a>
    </div>
  );
}
