import type { Metadata } from "next";
import { Barlow, Barlow_Condensed, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const barlow = Barlow({ subsets: ["latin"], variable: "--font-barlow", weight: ["400", "500", "600"] });
const barlowCond = Barlow_Condensed({ subsets: ["latin"], variable: "--font-barlow-cond", weight: ["500", "600", "700"] });
// HUD typeface (brief) and timecodes.
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", weight: ["400", "600", "800"] });

export const metadata: Metadata = { title: "Revline Studio" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${barlow.variable} ${barlowCond.variable} ${mono.variable}`}>
      <body className="font-sans text-[14px] antialiased">{children}</body>
    </html>
  );
}
