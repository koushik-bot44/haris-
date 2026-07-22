"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Quiet global footer. Like the header, it stays out of the focus surfaces
// (the interview and group-discussion rooms).
export function SiteFooter() {
  const pathname = usePathname();
  if (pathname.startsWith("/interview") || pathname.startsWith("/gd")) return null;

  return (
    <footer className="site-footer">
      <div className="inner">
        <div>
          <div className="brand">Placement Day</div>
          <p className="tagline">
            Voice-first mock interviews for campus placements. Built as a final-year project.
          </p>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <Link href="/">Practice</Link>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/history">History</Link>
          <Link href="/guidance">Guidance</Link>
        </nav>
      </div>
    </footer>
  );
}
