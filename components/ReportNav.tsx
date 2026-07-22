"use client";

export function ReportNav({ active }: { active: "dashboard" | "history" | "progress" }) {
  const link = (href: string, key: string, label: string) => (
    <a
      href={href}
      style={active === key ? { color: "var(--text)", fontWeight: 600, textDecoration: "none" } : undefined}
    >
      {label}
    </a>
  );
  return (
    <nav className="small" style={{ display: "flex", gap: 16, marginBottom: 18 }}>
      <a href="/">← New interview</a>
      {link("/dashboard", "dashboard", "Dashboard")}
      {link("/history", "history", "History")}
      {link("/progress", "progress", "Progress")}
    </nav>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="card" style={{ textAlign: "left" }}>
      <p style={{ marginTop: 0 }}>{message}</p>
      <a className="btn" href="/" style={{ display: "inline-block", textDecoration: "none" }}>
        Start an HR round
      </a>
    </div>
  );
}
