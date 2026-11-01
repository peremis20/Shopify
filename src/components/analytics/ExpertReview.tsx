"use client";

import { useEffect, useState } from "react";
import type { ReviewItem, Reviewer } from "@/lib/analytics/autopilot/expert-review";
import { api, pathOf } from "./seo-ui";
import { Card, CardHeader } from "./ui";

/**
 * Expert review: who reviews the site's articles, and the articles the app wrote that are waiting for them.
 * "Mark as reviewed" adds a "Reviewed by" line to the article, so only use it after the expert has read it.
 */
export function ExpertReview() {
  const [reviewer, setReviewer] = useState<Reviewer | null>(null);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [form, setForm] = useState({ name: "", credentials: "", url: "" });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (d: { reviewer: Reviewer | null; items: ReviewItem[]; error?: string }) => {
    setReviewer(d.reviewer);
    setItems(d.items);
    setError(d.error ?? null);
  };
  useEffect(() => {
    api<{ reviewer: Reviewer | null; items: ReviewItem[] }>("/api/content/review").then(apply).catch(() => setItems([]));
  }, []);

  async function send(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setError(null);
    try {
      apply(await api<{ reviewer: Reviewer | null; items: ReviewItem[]; error?: string }>("/api/content/review", body));
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (items === null) return null;
  const waiting = items.filter((i) => !i.reviewedAt);
  return (
    <Card className="mt-5">
      <CardHeader title="Expert review" />
      <p className="mb-3 text-sm text-dash-muted">
        Articles reviewed by a qualified expert rank better, most of all on health topics. Only mark an article reviewed after your expert has read it.
      </p>
      {reviewer && !editing ? (
        <p className="mb-3 text-sm text-dash-ink">
          Reviewer: <span className="font-semibold">{reviewer.name}</span>, {reviewer.credentials}{" "}
          <button onClick={() => (setForm({ name: reviewer.name, credentials: reviewer.credentials, url: reviewer.url ?? "" }), setEditing(true))} className="text-xs font-semibold text-dash-green hover:underline">
            Change
          </button>
        </p>
      ) : (
        <form
          onSubmit={(e) => (e.preventDefault(), void send("reviewer", { reviewer: form }))}
          className="mb-3 grid gap-2 sm:grid-cols-3"
        >
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Reviewer's full name" className="rounded-lg border border-dash-line bg-white px-3 py-2 text-sm" />
          <input value={form.credentials} onChange={(e) => setForm({ ...form, credentials: e.target.value })} placeholder="Credentials, e.g. RD, MS" className="rounded-lg border border-dash-line bg-white px-3 py-2 text-sm" />
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="Profile link (optional)" className="rounded-lg border border-dash-line bg-white px-3 py-2 text-sm" />
          <button type="submit" disabled={busy === "reviewer"} className="rounded-lg bg-dash-green px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 sm:col-span-3 sm:justify-self-start">
            {busy === "reviewer" ? "Saving…" : "Save reviewer"}
          </button>
        </form>
      )}
      {error && <p className="mb-2 text-sm text-dash-down">{error}</p>}
      {items.length === 0 ? (
        <p className="text-sm text-dash-muted">No articles written by the app yet.</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-dash-muted">{waiting.length} of {items.length} waiting for review</p>
          <ul className="divide-y divide-dash-line/60 text-sm">
            {items.map((i) => (
              <li key={i.resourceId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <a href={i.url} target="_blank" rel="noopener" className="min-w-0 flex-1 truncate text-dash-ink hover:underline">{pathOf(i.url)}</a>
                {i.reviewedAt ? (
                  <span className="text-xs text-dash-muted">Reviewed {new Date(i.reviewedAt).toLocaleDateString()}</span>
                ) : (
                  <button
                    onClick={() => void send(i.resourceId, { reviewed: i.resourceId })}
                    disabled={!reviewer || busy === i.resourceId}
                    title={reviewer ? "Adds a Reviewed by line to the article" : "Add a reviewer first"}
                    className="text-xs font-semibold text-dash-green hover:underline disabled:opacity-50"
                  >
                    {busy === i.resourceId ? "Adding…" : "Mark as reviewed"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
