"use client";

import { useEffect, useState } from "react";
import type { CreatorRow } from "@/lib/analytics/creators";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";

type View =
  | { show: false }
  | { show: true; lastRun: string | null; missing: string[]; creators: CreatorRow[]; draftsThisWeek: number; cap: number; analytics: boolean };

const fmt = (v: number) => v.toLocaleString();

function CopyMessage({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined)
      }
      className="rounded-lg border border-dash-line px-3 py-1.5 text-xs font-semibold text-dash-ink hover:border-dash-green"
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function CreatorCard({ c, onAct }: { c: CreatorRow; onAct: (action: "draft" | "dismiss", handle: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: "draft" | "dismiss") => {
    setBusy(true);
    setError(null);
    try {
      await onAct(action, c.handle);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't do that. Try again.");
    }
    setBusy(false);
  };
  const numbers = [
    c.followers !== null ? `${fmt(c.followers)} followers` : "numbers not looked up yet",
    c.engagement !== null && c.postsCounted ? `${(c.engagement * 100).toFixed(1)}% engagement over ${c.postsCounted} recent posts` : null,
    c.country ? `based in ${c.country}` : null,
  ].filter(Boolean);
  return (
    <div className="rounded-xl border border-dash-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <a href={`https://www.instagram.com/${c.handle}/`} target="_blank" rel="noreferrer" className="font-semibold text-dash-ink hover:underline">
            @{c.handle}
          </a>
          {c.name && <span className="ml-1 text-sm text-dash-muted">{c.name}</span>}
          <p className="text-xs text-dash-muted">{numbers.join(" · ")}</p>
        </div>
        {c.score !== null && <span className="rounded-full bg-dash-bg px-3 py-1 text-xs font-semibold text-dash-ink">Fit {c.score} of 100</span>}
      </div>
      {c.matched.length > 0 && <p className="mt-2 text-sm text-dash-ink">Posts about: {c.matched.join(", ")}</p>}
      {c.claimFlags.length > 0 && <p className="mt-1 text-sm text-dash-down">Recent posts make health claims: {c.claimFlags.map((p) => `"${p}"`).join(", ")}</p>}
      {c.competitor && <p className="mt-1 text-sm text-dash-down">{c.competitor}</p>}
      {c.stats && (
        <p className="mt-1 text-sm text-dash-ink">
          From their link: {fmt(c.stats.visits)} visits, {fmt(c.stats.signups)} signups, {fmt(c.stats.sales)} sales
        </p>
      )}
      {c.message && (
        <>
          <p className="mt-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-dash-bg p-3 text-sm text-dash-ink">{c.message}</p>
          <p className="mt-1 text-xs text-dash-muted">
            {c.messageChecked === "ai" ? "Checked by a second AI." : c.messageReason} Send it yourself from Instagram. DashPatrol never sends messages.
          </p>
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!c.message && c.draftable && (
          <button onClick={() => act("draft")} disabled={busy} className="rounded-lg bg-dash-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-dash-deep disabled:opacity-60">
            {busy ? "Writing" : "Draft message"}
          </button>
        )}
        {c.message && <CopyMessage text={c.message} />}
        <button onClick={() => act("dismiss")} disabled={busy} className="rounded-lg border border-dash-line px-3 py-1.5 text-xs font-semibold text-dash-ink hover:border-dash-green">
          Dismiss
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </div>
  );
}

/** Instagram creators who post about the site's topics, for the owner to contact themselves. Shown only with Instagram connected. */
export function Creators() {
  const [view, setView] = useState<View | null>(null);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<View>("/api/social/creators").then(setView).catch(() => setView(null));
  }, []);
  if (!view?.show) return null;
  const act = async (action: "draft" | "dismiss" | "add", h: string) => {
    setView(await api<View>("/api/social/creators", { action, handle: h }));
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await act("add", handle);
      setHandle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that.");
    }
  };
  return (
    <Card className="mt-6">
      <CardHeader title="Creators" />
      <p className="mb-3 text-xs text-dash-muted">
        Instagram creators who post about your topics, with their public numbers. Draft a message, copy it, and send it yourself. At most {view.cap} drafts a week
        ({view.draftsThisWeek} used). Each creator gets their own tracked link{view.analytics ? "" : "; connect Google Analytics to see visits and sales from it"}.
      </p>
      {view.missing.map((m) => (
        <p key={m} className="mb-2 rounded-lg bg-dash-bg p-2 text-sm text-dash-ink">
          {m}
        </p>
      ))}
      <div className="space-y-3">
        {view.creators.map((c) => (
          <CreatorCard key={c.handle} c={c} onAct={(a, h) => act(a, h)} />
        ))}
        {!view.creators.length && <p className="text-sm text-dash-ink">{view.lastRun ? "No creators found for your topics yet." : "The first search runs this week."}</p>}
      </div>
      <form onSubmit={add} className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="Add a username, like @name"
          className="min-w-0 flex-1 rounded-lg border border-dash-line px-3 py-1.5 text-sm"
        />
        <button className="rounded-lg border border-dash-line px-3 py-1.5 text-xs font-semibold text-dash-ink hover:border-dash-green">Add</button>
      </form>
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </Card>
  );
}
