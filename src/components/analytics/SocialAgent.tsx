"use client";

import { useEffect, useState } from "react";
import type { ReplyDraft, SocialDraft } from "@/lib/analytics/social-agent";
import type { CommunityIdea } from "@/lib/analytics/communities";
import type { LandingNote } from "@/lib/analytics/landing";
import { api, apiFresh } from "./seo-ui";
import { Card, CardHeader } from "./ui";
import { useIsMember } from "./team-role";

interface AgentState {
  posts: SocialDraft[];
  replies: ReplyDraft[];
  postedThisWeek: number;
  cap: number;
  replyCap: number;
  communities: (CommunityIdea & { line: string })[];
  landingNotes: LandingNote[];
}

/** Matching landing or product pages the posts don't link to yet, because of wording the claim guard flagged. */
function PageNotes({ notes }: { notes: LandingNote[] }) {
  if (!notes.length) return null;
  return (
    <div className="mt-4 rounded-xl border border-dash-line p-3">
      <p className="text-sm font-semibold text-dash-ink">This page has wording to fix before we send people there</p>
      <p className="text-xs text-dash-muted">Posts link to the article instead until the wording is changed.</p>
      <ul className="mt-2 space-y-2">
        {notes.map((n) => (
          <li key={n.url} className="break-words text-sm text-dash-ink">
            <a href={n.url} target="_blank" rel="noreferrer" className="font-semibold text-dash-green hover:underline">
              {n.url}
            </a>
            : {n.phrases.map((p) => `"${p}"`).join(", ")}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ThreadsInfo {
  configured: boolean;
  connected: boolean;
  username: string | null;
  auto: boolean;
  autoReply: boolean;
}

const KIND_LABEL = { tip: "Tip", question: "Question answered", explainer: "Short explainer" } as const;

/** One draft: Approve, Edit or Skip. Approve posts it to the owner's own profile. */
function DraftCard({
  label,
  context,
  text,
  link,
  note,
  onAct,
}: {
  label: string;
  context?: string;
  text: string;
  link?: string;
  note?: string | null;
  onAct: (action: "approve" | "skip", text: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const member = useIsMember();
  const [error, setError] = useState<string | null>(null);
  const act = async (action: "approve" | "skip") => {
    if (action === "approve" && !window.confirm("Post this now?")) return;
    setBusy(true);
    setError(null);
    try {
      await onAct(action, editing ? value : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't do that. Try again.");
    }
    setBusy(false);
  };
  return (
    <div className="rounded-xl border border-dash-line p-4">
      <p className="text-xs font-semibold text-dash-muted">{label}</p>
      {context && <p className="mt-1 break-words text-sm text-dash-muted">{context}</p>}
      {editing ? (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          className="mt-2 w-full rounded-lg border border-dash-line bg-white p-2 text-sm text-dash-ink"
        />
      ) : (
        <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-dash-bg p-3 text-sm text-dash-ink">{text}</p>
      )}
      {link && <p className="mt-1 break-words text-xs text-dash-muted">Links to {link.split("?")[0]}</p>}
      {note && <p className="mt-1 text-xs text-dash-muted">{note}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {member ? <span className="text-xs text-dash-muted">The main sign in approves posts.</span> : <button onClick={() => act("approve")} disabled={busy} className="rounded-lg bg-dash-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-dash-deep disabled:opacity-60">
          {busy ? "Working" : "Approve"}
        </button>}
        <button onClick={() => setEditing((v) => !v)} disabled={busy} className="rounded-lg border border-dash-line px-3 py-1.5 text-xs font-semibold text-dash-ink hover:border-dash-green">
          {editing ? "Keep the draft" : "Edit"}
        </button>
        <button onClick={() => act("skip")} disabled={busy} className="rounded-lg border border-dash-line px-3 py-1.5 text-xs font-semibold text-dash-ink hover:border-dash-green">
          Skip
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </div>
  );
}

function Toggle({ checked, label, hint, onChange }: { checked: boolean; label: string; hint: string; onChange: (v: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  // Automatic posting is the main sign in's choice.
  const member = useIsMember();
  return (
    <label className="mt-2 flex items-start gap-2 text-sm text-dash-ink">
      <input
        type="checkbox"
        checked={checked}
        disabled={busy || member}
        onChange={async (e) => {
          setBusy(true);
          await onChange(e.target.checked).catch(() => undefined);
          setBusy(false);
        }}
        className="mt-1"
      />
      <span>
        {label}
        <span className="block text-xs text-dash-muted">{member ? "Only the main sign in can change this for the business." : hint}</span>
      </span>
    </label>
  );
}

function CopyText({ text }: { text: string }) {
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
      {done ? "Copied" : "Copy the answer"}
    </button>
  );
}

/** Where people ask about the site's topics, and a helpful answer the owner can post there themselves. */
function Communities({ items }: { items: AgentState["communities"] }) {
  if (!items.length) return null;
  return (
    <div className="mt-5">
      <p className="text-sm font-semibold text-dash-ink">Communities to join</p>
      <p className="mb-2 text-xs text-dash-muted">
        Places where people ask about your topics. DashPatrol never joins or posts in groups for you. Join the ones that fit, read their rules, and post the
        answer yourself if it helps someone.
      </p>
      <div className="space-y-3">
        {items.map((c) => (
          <div key={`${c.where}${c.search}`} className="rounded-xl border border-dash-line p-4">
            <p className="text-sm font-semibold text-dash-ink">{c.line}</p>
            <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-dash-bg p-3 text-sm text-dash-ink">{c.answer}</p>
            <p className="mt-1 break-words text-xs text-dash-muted">
              From your page {c.pageUrl}. {c.checked === "ai" ? "Checked by a second AI." : "No second AI was free, so read it before you post it."}
            </p>
            <div className="mt-2 flex justify-end">
              <CopyText text={c.answer} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The social helper: post and answer drafts for the owner to approve, and the automatic posting switches. */
export function SocialAgent() {
  const [state, setState] = useState<AgentState | null>(null);
  const [threads, setThreads] = useState<ThreadsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<AgentState>("/api/social/agent").then(setState).catch(() => setState(null));
    api<ThreadsInfo>("/api/social/threads").then(setThreads).catch(() => setThreads(null));
  }, []);
  if (!threads?.configured && !state?.communities.length && !state?.landingNotes?.length) return null;

  const act = async (type: "post" | "reply", id: string, action: "approve" | "skip", text: string | null) => {
    const next = await api<AgentState>("/api/social/agent", { type, id, action, ...(text !== null ? { text } : {}) });
    setState(next);
  };
  const setSwitch = async (patch: { auto?: boolean; autoReply?: boolean }) => {
    setError(null);
    try {
      const out = await api<{ auto: boolean; autoReply: boolean }>("/api/social/threads/settings", patch);
      setThreads((t) => (t ? { ...t, ...out } : t));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    }
  };
  const posts = state?.posts.filter((p) => p.status === "draft") ?? [];
  const held = state?.posts.filter((p) => p.status === "held" || p.status === "failed") ?? [];
  const replies = state?.replies.filter((r) => r.status === "draft") ?? [];
  const heldReplies = state?.replies.filter((r) => r.status === "held" || r.status === "failed") ?? [];

  return (
    <Card className="mt-6">
      <CardHeader title="Social helper" />
      <p className="mb-3 text-xs text-dash-muted">
        Short tips, answered questions and explainers taken from your own pages, on what people search for now. Each one is checked for health claims and by a
        second AI. Nothing is posted until you approve it, unless you turn on automatic posting.
      </p>
      {!threads?.configured ? null : !threads.connected ? (
        <p className="text-sm text-dash-ink">Connect Threads under Share this week to get drafts here.</p>
      ) : (
        <>
          <div className="rounded-xl bg-dash-bg p-3">
            <p className="text-sm text-dash-ink">
              Threads as <strong>@{threads.username}</strong>. {state?.postedThisWeek ?? 0} of {state?.cap ?? 3} posts this week.
            </p>
            <Toggle
              checked={threads.auto}
              label="Post checked drafts to Threads by itself"
              hint="When this is off, a post goes out only when you click Approve."
              onChange={(v) => setSwitch({ auto: v })}
            />
            <Toggle
              checked={threads.autoReply}
              label="Answer replies by itself"
              hint={`Off unless you turn it on. At most ${state?.replyCap ?? 10} answers a day, only ones a second AI checked.`}
              onChange={(v) => setSwitch({ autoReply: v })}
            />
            {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
          </div>
          <div className="mt-4 space-y-3">
            {posts.map((p) => (
              <DraftCard
                key={`p${p.id}`}
                label={`${KIND_LABEL[p.kind]} for Threads`}
                context={`People search for: ${p.topic}`}
                text={p.text}
                link={p.link}
                note={p.checked === "ai" ? "Checked by a second AI." : p.reason}
                onAct={(a, t) => act("post", p.id, a, t)}
              />
            ))}
            {replies.map((r) => (
              <DraftCard
                key={`r${r.replyId}`}
                label={`Answer to @${r.username}`}
                context={`They wrote: ${r.question}`}
                text={r.answer ?? ""}
                note={r.checked === "ai" ? "Checked by a second AI." : r.reason}
                onAct={(a, t) => act("reply", r.replyId, a, t)}
              />
            ))}
            {!posts.length && !replies.length && <p className="text-sm text-dash-ink">No drafts waiting. New ones come once a day.</p>}
          </div>
          {held.length + heldReplies.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-dash-muted">Held back by the checks, or not confirmed by Threads</p>
              <ul className="mt-2 space-y-2">
                {held.map((p) => (
                  <li key={`h${p.id}`} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-dash-bg p-2 text-sm text-dash-ink">
                    <span className="min-w-0 break-words">
                      {p.topic}: {p.reason}
                    </span>
                    <button onClick={() => act("post", p.id, "skip", null).catch(() => undefined)} className="text-xs font-semibold text-dash-green hover:underline">
                      Dismiss
                    </button>
                  </li>
                ))}
                {heldReplies.map((r) => (
                  <li key={`hr${r.replyId}`} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-dash-bg p-2 text-sm text-dash-ink">
                    <span className="min-w-0 break-words">
                      Answer to @{r.username}: {r.reason}
                    </span>
                    <button onClick={() => act("reply", r.replyId, "skip", null).catch(() => undefined)} className="text-xs font-semibold text-dash-green hover:underline">
                      Dismiss
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button onClick={() => apiFresh<AgentState>("/api/social/agent").then(setState).catch(() => undefined)} className="mt-3 text-xs font-semibold text-dash-green hover:underline">
            Refresh
          </button>
        </>
      )}
      <PageNotes notes={state?.landingNotes ?? []} />
      <Communities items={state?.communities ?? []} />
    </Card>
  );
}
