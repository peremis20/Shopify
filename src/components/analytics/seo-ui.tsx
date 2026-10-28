"use client";

import type { ReactNode } from "react";

/** Small shared pieces for the SEO tool tabs. */

export async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export function TrackButton({ onClick, tracked, label = "Track" }: { onClick: () => void; tracked?: boolean; label?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={tracked}
      className="whitespace-nowrap rounded-full border border-dash-line px-2.5 py-0.5 text-xs font-semibold text-dash-green hover:border-dash-green/40 disabled:border-transparent disabled:text-dash-muted"
    >
      {tracked ? "Tracked" : `+ ${label}`}
    </button>
  );
}

export function Explainer({ children }: { children: ReactNode }) {
  return <p className="mb-3 max-w-3xl text-sm text-dash-muted">{children}</p>;
}

export const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname || "/";
  } catch {
    return url;
  }
};
