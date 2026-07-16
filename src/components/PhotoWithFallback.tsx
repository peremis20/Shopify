"use client";

import { useState } from "react";

interface Props {
  src: string;
  alt: string;
  /** Tailwind gradient classes shown while loading or if the photo fails. */
  fallbackGradient: string;
  className?: string;
  /** Optional content (e.g. an emoji) centered in the fallback. */
  fallbackContent?: React.ReactNode;
}

/**
 * Renders a real photo, but degrades gracefully: until the image loads (and
 * permanently if it errors) a branded gradient is shown instead of a broken
 * image icon. This keeps the UI polished even when a photo host is unreachable.
 */
export default function PhotoWithFallback({
  src,
  alt,
  fallbackGradient,
  className = "",
  fallbackContent,
}: Props) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(
    "loading"
  );

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Gradient layer — visible while loading and if the photo errors */}
      <div
        className={`absolute inset-0 bg-gradient-to-br ${fallbackGradient} transition-opacity duration-500 ${
          status === "loaded" ? "opacity-0" : "opacity-100"
        }`}
      >
        {status === "error" && fallbackContent && (
          <div className="flex h-full w-full items-center justify-center text-5xl opacity-80">
            {fallbackContent}
          </div>
        )}
      </div>

      {status !== "error" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("error")}
          className={`relative h-full w-full object-cover transition-opacity duration-500 ${
            status === "loaded" ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </div>
  );
}
