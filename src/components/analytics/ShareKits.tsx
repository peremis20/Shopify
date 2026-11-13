"use client";

import { useEffect, useState } from "react";
import type { ShareItem } from "@/lib/analytics/autopilot/share-kit";
import type { ThreadsPost } from "@/lib/analytics/threads";
import { isEmbedded } from "./embedded-client";
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

interface ThreadsState {
  configured: boolean;
  connected: boolean;
  expired: boolean;
  username: string | null;
  auto: boolean;
  lastError: string | null;
  posts: ThreadsPost[];
  postedThisWeek: number;
  cap: number;
}

/** Connect Threads, or say which profile posts go to and whether the autopilot posts by itself. */
function ThreadsBar({ t, onChange }: { t: ThreadsState; onChange: (t: ThreadsState) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!t.configured) return null;
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/social/threads/link");
      if (isEmbedded()) window.open(url, "_top");
      else window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open Threads. Try again.");
      setBusy(false);
    }
  };
  const setAuto = async (auto: boolean) => {
    setBusy(true);
    setError(null);
    await api("/api/social/threads/settings", { auto })
      .then(() => onChange({ ...t, auto }))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't save that."));
    setBusy(false);
  };
  const disconnect = async () => {
    if (!window.confirm("Stop posting to Threads? Posts already on Threads stay there.")) return;
    setBusy(true);
    setError(null);
    await api("/api/social/threads/disconnect", {})
      .then(() => onChange({ ...t, connected: false, expired: false, username: null, auto: false }))
      .catch(() => setError("Couldn't stop posting to Threads. Check your connection and try again."));
    setBusy(false);
  };
  return (
    <div className="mb-3 rounded-xl bg-dash-bg p-3 text-sm text-dash-ink">
      {t.connected ? (
        <>
          <p>
            Posting to Threads as <strong>@{t.username}</strong>. {t.postedThisWeek} of {t.cap} posts this week.{" "}
            <button onClick={disconnect} disabled={busy} className="text-xs font-semibold text-dash-green hover:underline">Stop posting to Threads</button>
          </p>
          <label className="mt-2 flex items-start gap-2">
            <input type="checkbox" checked={t.auto} disabled={busy} onChange={(e) => setAuto(e.target.checked)} className="mt-1" />
            <span>
              Post each new article to Threads by itself.
              <span className="block text-xs text-dash-muted">When this is off, nothing goes to Threads until you click Post to Threads.</span>
            </span>
          </label>
          {t.lastError && <p className="mt-2 text-dash-down">{t.lastError}</p>}
        </>
      ) : (
        <p>
          {t.expired ? "The Threads connection ran out. " : "Post these to your own Threads profile from here. "}
          <button onClick={connect} disabled={busy} className="font-semibold text-dash-green hover:underline">
            {t.expired ? "Connect Threads again" : "Connect Threads"}
          </button>
        </p>
      )}
      {error && <p className="mt-2 text-dash-down">{error}</p>}
    </div>
  );
}

function ThreadsButton({ item, t, onPosted }: { item: ShareItem; t: ThreadsState; onPosted: (p: ThreadsPost, n: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = t.posts.find((p) => p.changeId === item.changeId);
  if (done) {
    return done.permalink ? (
      <a href={done.permalink} target="_blank" rel="noreferrer" className="text-xs font-semibold text-dash-green hover:underline">
        On Threads{done.by === "autopilot" ? ", posted by the autopilot" : ""}
      </a>
    ) : (
      <span className="text-xs text-dash-muted">On Threads</span>
    );
  }
  if (!t.connected) return null;
  const post = async () => {
    if (!window.confirm(`Post this to Threads as @${t.username}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ post: ThreadsPost; postedThisWeek: number }>("/api/social/threads/post", { changeId: item.changeId });
      onPosted(out.post, out.postedThisWeek);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't post it.");
    }
    setBusy(false);
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button onClick={post} disabled={busy} className="rounded-lg bg-dash-ink px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {busy ? "Posting" : "Post to Threads"}
      </button>
      {error && <span className="text-xs text-dash-down">{error}</span>}
    </span>
  );
}

function ShareCard({ item, onPosted, threads, onThreads }: { item: ShareItem; onPosted: (posted: boolean) => void; threads: ThreadsState | null; onThreads: (p: ThreadsPost, n: number) => void }) {
  const [ch, setCh] = useState<Channel>("linkedin");
  const text = textOf(item, ch);
  return (
    <div className="rounded-xl border border-dash-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <a href={item.url} target="_blank" rel="noreferrer" className="break-words font-semibold text-dash-ink hover:underline">{item.title}</a>
          <p className="text-xs text-dash-muted">Made {new Date(item.at).toLocaleDateString()} · checked by a second AI</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
        {threads && <ThreadsButton item={item} t={threads} onPosted={onThreads} />}
        <button
          onClick={() => onPosted(!item.postedAt)}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${item.postedAt ? "bg-dash-line text-dash-ink" : "bg-dash-green text-white hover:bg-dash-deep"}`}
        >
          {item.postedAt ? "Posted. Undo" : "Mark as posted"}
        </button>
        </div>
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
      <pre className="mt-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-dash-bg p-3 font-dash text-sm text-dash-ink">{text}</pre>
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
  const [failed, setFailed] = useState(false);
  const [threads, setThreads] = useState<ThreadsState | null>(null);
  useEffect(() => {
    api<{ items: ShareItem[] }>("/api/autopilot/share").then((d) => setItems(d.items)).catch(() => setItems([]));
    api<ThreadsState>("/api/social/threads").then(setThreads).catch(() => setThreads(null));
  }, []);
  const onThreads = (p: ThreadsPost, n: number) => setThreads((t) => (t ? { ...t, posts: [p, ...t.posts], postedThisWeek: n, lastError: null } : t));
  if (!items?.length) return null;
  const todo = items.filter((i) => !i.postedAt);
  const posted = items.filter((i) => i.postedAt);
  const mark = (changeId: string, p: boolean) =>
    api<{ items: ShareItem[] }>("/api/autopilot/share", { changeId, posted: p })
      .then((d) => (setItems(d.items), setFailed(false)))
      .catch(() => setFailed(true));
  return (
    <Card className="mt-6">
      <CardHeader title="Share this week" />
      <p className="mb-3 text-xs text-dash-muted">
        Posts and a short video script for each new article, written from the article and checked by a second AI. Copy, post, then mark it posted.
      </p>
      {threads && <ThreadsBar t={threads} onChange={setThreads} />}
      {failed && <p className="mb-3 text-sm text-dash-down">Couldn&apos;t save that. Check your connection and try again.</p>}
      {todo.length ? (
        <div className="space-y-3">{todo.map((i) => <ShareCard key={i.changeId} item={i} onPosted={(p) => mark(i.changeId, p)} threads={threads} onThreads={onThreads} />)}</div>
      ) : (
        <p className="text-sm text-dash-ink">All caught up. New posts appear here after the next article.</p>
      )}
      {posted.length > 0 && (
        <div className="mt-4">
          <button onClick={() => setShowPosted((v) => !v)} className="text-xs font-semibold text-dash-green hover:underline">
            {showPosted ? "Hide" : "Show"} posted ({posted.length})
          </button>
          {showPosted && <div className="mt-3 space-y-3">{posted.map((i) => <ShareCard key={i.changeId} item={i} onPosted={(p) => mark(i.changeId, p)} threads={threads} onThreads={onThreads} />)}</div>}
        </div>
      )}
    </Card>
  );
}
