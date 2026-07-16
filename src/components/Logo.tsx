"use client";

import Link from "next/link";
import { useState } from "react";

export default function Logo({ className = "" }: { className?: string }) {
  // Show the styled text mark by default; if /images/logo.png loads
  // successfully, swap to it. If it's missing, the text mark stays (no
  // broken-image icon or alt text ever shows).
  const [logoLoaded, setLogoLoaded] = useState(false);

  return (
    <Link href="/" className={`group inline-flex items-center ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/logo.png"
        alt="YoYo AK-100"
        onLoad={() => setLogoLoaded(true)}
        onError={() => setLogoLoaded(false)}
        className={logoLoaded ? "h-12 w-auto" : "hidden"}
      />
      {!logoLoaded && (
        <span className="flex flex-col leading-none">
          <span
            className="text-3xl font-extrabold tracking-tight text-brand-green-light drop-shadow-sm"
            style={{ fontFamily: "var(--font-script)" }}
          >
            YoYo
          </span>
          <span className="text-xs font-bold tracking-[0.35em] text-brand-orange">
            AK-100
          </span>
        </span>
      )}
    </Link>
  );
}
