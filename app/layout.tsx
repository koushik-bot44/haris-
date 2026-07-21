import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Placement Day Simulator",
  description:
    "Voice-first mock interviews for campus placements — evidence-based scoring, delivery metrics, and the rounds no other tool simulates.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
