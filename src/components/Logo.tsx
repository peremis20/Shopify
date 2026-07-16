"use client";

import Link from "next/link";
import { useState } from "react";

export default function Logo({ className = "" }: { className?: string }) {
  const [hasImage, setHasImage] = useState(true);

  return (
    <Link href="/" className={`group inline-flex items-center ${className}`}>
      {/* Uses /images/logo.png if present; otherwise falls back to the text mark */}
      {hasImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/images/logo.png"
          alt="YoYo AK-100"
          className="h-12 w-auto"
          onError={() => setHasImage(false)}
        />
      ) : (
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
