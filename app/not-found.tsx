import Link from "next/link";

export default function NotFound() {
  return (
    <main className="wrap">
      <section className="card panel-enter">
        <h2>That page doesn't exist</h2>
        <p className="muted">The link may be old, or the round it pointed to was never saved on this device.</p>
        <div className="inline-actions">
          <Link className="btn" href="/">
            Back to setup
          </Link>
          <Link className="btn secondary" href="/history">
            Your history
          </Link>
        </div>
      </section>
    </main>
  );
}
