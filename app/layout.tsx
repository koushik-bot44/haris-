import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import { AppHeader } from "@/components/AppHeader";
import { SiteFooter } from "@/components/SiteFooter";
import "./globals.css";

// Geist is the face ElevenLabs actually ships as --font-sans, and it is what
// makes their UI read the way it does: neutral, tight, engineered.
const fontUi = Geist({
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
});

// Newsreader stays. ElevenLabs has no serif to adopt, and the display face
// carrying the interviewer's words and the verdicts is this product's own
// voice — the one thing that stops it looking like every other AI demo.
const fontDisplay = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

// For the things that are figures, not prose: the question counter, the GD
// countdown, the code editor chrome.
const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Placement Day Simulator",
  description:
    "Voice-first mock interviews for campus placements — evidence-based scoring, delivery metrics, and the rounds no other tool simulates.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fontUi.variable} ${fontDisplay.variable} ${fontMono.variable}`}
    >
      <body>
        <AppHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
