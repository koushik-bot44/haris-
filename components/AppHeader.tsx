"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const NAV = [
  { href: "/", label: "Practice" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/history", label: "History" },
  { href: "/progress", label: "Progress" },
  { href: "/guidance", label: "Guidance" },
] as const;

interface AuthUser {
  id: string;
  name: string;
  email: string;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Global shell nav. The interview and GD rooms are focus surfaces — no chrome. */
export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Re-resolve the session on every navigation so login/logout reflect the
  // moment the page changes (this client component never remounts otherwise).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((d: { user: AuthUser | null }) => {
        if (!cancelled) {
          setUser(d.user ?? null);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Best-effort — the cookie clear is server-side; a failed POST just
      // leaves the session, which the next request re-checks anyway.
    } finally {
      setUser(null);
      setSigningOut(false);
      router.refresh();
    }
  }

  if (pathname.startsWith("/interview") || pathname.startsWith("/gd")) return null;

  return (
    <header className="app-header">
      <div className="inner">
        <Link href="/" className="wordmark">
          Placement Day
        </Link>
        <nav className="app-nav" aria-label="Primary">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="header-auth">
          {!loaded ? null : user ? (
            <>
              <span className="header-user">Hi, {firstName(user.name)}</span>
              <button
                type="button"
                className="btn ghost sm"
                onClick={signOut}
                disabled={signingOut}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="header-signin">
                Sign in
              </Link>
              <Link href="/register" className="btn sm">
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
