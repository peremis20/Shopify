"use client";

import { useEffect, useState } from "react";
import type { ShareItem } from "@/lib/analytics/autopilot/share-kit";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";

const CHANNELS = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "x", label: "X" },
  { id: "video", label: "Short video" },
] as const;
type Channel = (typeof CHANNELS)[number]["id"];

const textOf = (item: ShareItem, ch: Channel) =>
  ch === "video"
    ? `Hook: ${item.kit.video.hook}\n\nScript:\n${item.kit.video.script}\n\nCaption: ${item.kit.video.caption}`
    : item.kit[ch];

function CopyButton({ text }: { text: string }) {
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

function ShareCard({ item, onPosted }: { item: ShareItem; onPosted: (posted: boolean) => void }) {
  const [ch, setCh] = useState<Channel>("linkedin");
  const text = textOf(item, ch);
  return (
    <div className="rounded-xl border border-dash-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <a href={item.url} target="_blank" rel="noreferrer" className="font-semibold text-dash-ink hover:underline">{item.title}</a>
          <p className="text-xs text-dash-muted">Made {new Date(item.at).toLocaleDateString()} · checked by a second AI</p>
        </div>
        <button
          onClick={() => onPosted(!item.postedAt)}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${item.postedAt ? "bg-dash-line text-dash-ink" : "bg-dash-green text-white hover:bg-dash-deep"}`}
        >
          {item.postedAt ? "Posted. Undo" : "Mark as posted"}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5" role="tablist">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={ch === c.id}
            onClick={() => setCh(c.id)}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${ch === c.id ? "bg-dash-green text-white" : "bg-dash-bg text-dash-ink hover:bg-dash-line"}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-dash-bg p-3 font-dash text-sm text-dash-ink">{text}</pre>
      <div className="mt-2 flex justify-end">
        <CopyButton text={text} />
      </div>
    </div>
  );
}

/** Social posts and short video scripts for each new article, ready for the owner to post. */
export function ShareKits() {
  const [items, setItems] = useState<ShareItem[] | null>(null);
  const [showPosted, setShowPosted] = useState(false);
  useEffect(() => {
    api<{ items: ShareItem[] }>("/api/autopilot/share").then((d) => setItems(d.items)).catch(() => setItems([]));
  }, []);
  if (!items?.length) return null;
  const todo = items.filter((i) => !i.postedAt);
  const posted = items.filter((i) => i.postedAt);
  const mark = (changeId: string, p: boolean) =>
    api<{ items: ShareItem[] }>("/api/autopilot/share", { changeId, posted: p }).then((d) => setItems(d.items)).catch(() => undefined);
  return (
    <Card className="mt-6">
      <CardHeader title="Share this week" />
      <p className="mb-3 text-xs text-dash-muted">
        Posts and a short video script for each new article, written from the article and checked by a second AI. Copy, post, then mark it posted.
      </p>
      {todo.length ? (
        <div className="space-y-3">{todo.map((i) => <ShareCard key={i.changeId} item={i} onPosted={(p) => mark(i.changeId, p)} />)}</div>
      ) : (
        <p className="text-sm text-dash-ink">All caught up. New posts appear here after the next article.</p>
      )}
      {posted.length > 0 && (
        <div className="mt-4">
          <button onClick={() => setShowPosted((v) => !v)} className="text-xs font-semibold text-dash-green hover:underline">
            {showPosted ? "Hide" : "Show"} posted ({posted.length})
          </button>
          {showPosted && <div className="mt-3 space-y-3">{posted.map((i) => <ShareCard key={i.changeId} item={i} onPosted={(p) => mark(i.changeId, p)} />)}</div>}
        </div>
      )}
    </Card>
  );
}
