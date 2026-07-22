import type { Metadata } from "next";
import { Newsreader, Schibsted_Grotesk } from "next/font/google";
import { AppHeader } from "@/components/AppHeader";
import { SiteFooter } from "@/components/SiteFooter";
import "./globals.css";

const fontUi = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
});

const fontDisplay = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Placement Day Simulator",
  description:
    "Voice-first mock interviews for campus placements — evidence-based scoring, delivery metrics, and the rounds no other tool simulates.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fontUi.variable} ${fontDisplay.variable}`}>
      <body>
        <AppHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
