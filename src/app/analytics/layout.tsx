import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";

const serif = Fraunces({ subsets: ["latin"], variable: "--font-serif", display: "swap" });
const sans = Inter({ subsets: ["latin"], variable: "--font-dash", display: "swap" });

export const metadata: Metadata = {
  title: "DashPatrol",
  description: "Your SEO on autopilot: rankings, content and backlinks, handled.",
  robots: { index: false, follow: false },
};

export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${serif.variable} ${sans.variable}`}>{children}</div>;
}
