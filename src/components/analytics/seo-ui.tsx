"use client";

import { useState, type ReactNode } from "react";
import type { TargetResult } from "@/lib/analytics/autopilot/targets";

/** Small shared pieces for the SEO tool tabs. */

/** Recent GET answers, shared by every part of the page that asks the same thing (Home and Keywords both read ranks). */
const recent = new Map<string, { at: number; p: Promise<unknown> }>();
const FRESH_MS = 60_000;
/**
 * The last answers are kept for this tab for a few minutes. When a new answer is slow, the kept one shows at once
 * instead of a blank box; the new one is ready for the next look. Anything the owner changes clears them.
 */
const KEPT_MS = 5 * 60_000;
const WAIT_MS = 400;
const PREFIX = "dp:get:";

function kept<T>(url: string): T | undefined {
  // Only answers for the account this tab last loaded (set by the dashboard once it knows who is signed in).
  if (!keptOwner()) return undefined;
  try {
    const raw = sessionStorage.getItem(PREFIX + url);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { at: number; data: T };
    return Date.now() - v.at < KEPT_MS ? v.data : undefined;
  } catch {
    return undefined;
  }
}

function keep(url: string, data: unknown) {
  try {
    sessionStorage.setItem(PREFIX + url, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* storage full or blocked: the page still works, just without the head start */
  }
}

/** Who the kept answers belong to in this tab; a different account forgets them all. */
export function keptOwner(): string | null {
  try {
    return sessionStorage.getItem("dp:owner");
  } catch {
    return null;
  }
}
export function setKeptOwner(email: string | null) {
  try {
    if (email) sessionStorage.setItem("dp:owner", email);
  } catch {
    /* blocked storage */
  }
}

export async function api<T>(url: string, body?: unknown, fresh = false): Promise<T> {
  if (body === undefined) {
    const hit = recent.get(url);
    if (hit && !fresh && Date.now() - hit.at < FRESH_MS) return hit.p as Promise<T>;
    const p = request<T>(url).then((d) => (keep(url, d), d));
    recent.set(url, { at: Date.now(), p });
    // A failed answer is never reused.
    p.catch(() => recent.delete(url));
    const before = fresh ? undefined : kept<T>(url);
    if (before === undefined) return p;
    // A quick new answer wins (an error too, so it is seen); a slow one doesn't keep the page blank.
    return Promise.race([p, new Promise<T>((done) => setTimeout(() => done(before), WAIT_MS))]);
  }
  // Anything sent can change what the pages show, so the next read asks again.
  clearApiCache();
  return request<T>(url, body);
}

/** Forget every shared answer (after a change, and on sign out). */
export function clearApiCache() {
  recent.clear();
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith("dp:")) sessionStorage.removeItem(k);
  } catch {
    /* blocked storage: nothing kept */
  }
}

/** A GET that always asks again (an Update button). */
export function apiFresh<T>(url: string): Promise<T> {
  recent.delete(url);
  return api<T>(url, undefined, true);
}

async function request<T>(url: string, body?: unknown): Promise<T> {
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
        <div className="absolute right-0 z-30 mt-2 max-h-[70vh] w-80 max-w-[85vw] overflow-auto whitespace-normal break-words rounded-xl border border-dash-line bg-white p-3 text-left text-xs leading-relaxed shadow-lg">
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
          {result.pageOne?.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 font-semibold text-dash-ink">Who&rsquo;s on Google page 1</p>
              <ol className="space-y-0.5">
                {result.pageOne.map((p) => (
                  <li key={`${p.position}-${p.domain}`} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      <span className="text-dash-muted">{p.position}.</span> {p.domain}
                    </span>
                    {p.authority !== null && (
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 font-medium tabular-nums ${p.authority < 5 ? "bg-dash-up/10 text-dash-up" : "bg-dash-down/10 text-dash-down"}`}
                        title="Site authority from Open PageRank, 0 to 10. Under 5 is beatable."
                      >
                        {p.authority.toFixed(1)}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              {result.pageOne.some((p) => p.authority !== null) && (
                <p className="mt-1 text-dash-muted">Green scores under 5 are sites you can outrank.</p>
              )}
            </div>
          )}
          {result.easier.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 font-semibold text-dash-ink">More long tail searches to rank for first</p>
              <ul className="space-y-1.5">
                {result.easier.map((e) => (
                  <li key={e.keyword} className="flex flex-wrap items-center justify-between gap-2">
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
