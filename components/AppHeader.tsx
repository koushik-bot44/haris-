"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Practice" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/history", label: "History" },
  { href: "/progress", label: "Progress" },
  { href: "/guidance", label: "Guidance" },
] as const;

/** Global shell nav. The interview and GD rooms are focus surfaces — no chrome. */
export function AppHeader() {
  const pathname = usePathname();
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
      </div>
    </header>
  );
}
