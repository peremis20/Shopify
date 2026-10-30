"use client";

import { useState, type ReactNode } from "react";
import type { TargetResult } from "@/lib/analytics/autopilot/targets";

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

const pagePath = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/**
 * "Rank for this": hands a search to the autopilot. It picks the page that fits,
 * checks Google page one, works on the page first in line, and suggests easier
 * searches on the same topic when page one is all big sites.
 */
export function RankForThis({ keyword, monthlySearches, label = "Rank for this" }: { keyword: string; monthlySearches?: number | null; label?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [result, setResult] = useState<TargetResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = () => {
    setState("busy");
    setError(null);
    api<TargetResult>("/api/seo/target", { keyword, monthlySearches: monthlySearches ?? undefined })
      .then((r) => {
        setResult(r);
        setState("done");
      })
      .catch((e) => {
        setError(e.message);
        setState("idle");
      });
  };

  return (
    <span className="relative inline-block">
      <button
        onClick={go}
        disabled={state !== "idle"}
        className="whitespace-nowrap rounded-full bg-dash-green px-2.5 py-0.5 text-xs font-semibold text-white hover:bg-dash-deep disabled:bg-dash-green/40"
      >
        {state === "busy" ? "Checking Google…" : state === "done" ? "Working on it" : label}
      </button>
      {error && <span className="ml-2 text-xs text-dash-down">{error}</span>}
      {result && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-xl border border-dash-line bg-white p-3 text-left text-xs shadow-lg">
          <button onClick={() => setResult(null)} className="float-right text-dash-muted hover:text-dash-ink" aria-label="Close">
            ✕
          </button>
          <p className="mb-1 font-semibold text-dash-ink">&ldquo;{result.target.keyword}&rdquo;</p>
          <p className={result.target.winnable === false ? "text-dash-down" : "text-dash-up"}>{result.target.why}</p>
          {result.added.length > 0 && (
            <p className="mt-2 text-dash-ink">
              Added as main targets, since specific searches rank first:{" "}
              <span className="font-semibold">{result.added.join(", ")}</span>. &ldquo;{result.target.keyword}&rdquo; is worked into
              their pages to support them.
            </p>
          )}
          <p className="mt-2 text-dash-ink">
            {result.target.page ? (
              <>
                The autopilot will work on{" "}
                <a href={result.target.page} target="_blank" rel="noreferrer" className="font-semibold underline">
                  {pagePath(result.target.page)}
                </a>{" "}
                first: title, description, a new section and links from your other articles. It&rsquo;s checked on Google
                every day in Rank tracker.
              </>
            ) : (
              <>No page on your site is about this yet, so the autopilot will write a new article for it from what ranks on Google page 1 and post it to your blog (up to 3 new articles a week, set in Autopilot). It&rsquo;s checked on Google daily in Rank tracker.</>
            )}
          </p>
          {result.easier.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 font-semibold text-dash-ink">More long tail searches to rank for first</p>
              <ul className="space-y-1.5">
                {result.easier.map((e) => (
                  <li key={e.keyword} className="flex items-center justify-between gap-2">
                    <span>
                      {e.keyword} <span className="text-dash-muted">· {e.monthlySearches.toLocaleString()}/mo</span>
                    </span>
                    <RankForThis keyword={e.keyword} monthlySearches={e.monthlySearches} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
