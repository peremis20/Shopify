"use client";

import { useEffect, useState } from "react";
import type { Journalist, MediaRequest, PaidOpportunity } from "@/lib/analytics/autopilot/press";
import { CRM_STATUSES, journalistsCsv, mailtoFor, STATUS_LABEL, type CrmStatus } from "@/lib/analytics/autopilot/press-crm";
import { isEmbedded } from "./embedded-client";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";

type Row = Journalist & { status: CrmStatus; due: boolean };

interface View {
  journalists: Row[];
  followUpsToday: number;
  topics: string[];
  canFindNow: boolean;
  paid: PaidOpportunity[];
  paidNote: string;
  requests: MediaRequest[];
  requestsNote: string | null;
  platforms: { name: string; host: string; url: string }[];
  draftsLeft: number;
  cap: number;
  lastRun: { press: string | null; requests: string | null };
}

const btn = "rounded-lg border border-dash-line px-3 py-1.5 text-xs font-semibold text-dash-ink hover:border-dash-green disabled:opacity-60";
const primary = "rounded-lg bg-dash-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-dash-deep disabled:opacity-60";
const input = "w-full rounded-lg border border-dash-line bg-white px-2 py-1.5 text-sm text-dash-ink";
const dayText = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString() : null);

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={btn}
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined)
      }
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** Runs one action and shows its error under the card. */
function useAct(onView: (v: View) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    setError(null);
    try {
      onView(await api<View>("/api/outreach", body));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't do that. Try again.");
    }
    setBusy(null);
  };
  return { busy, error, act };
}

/** Where to look for a contact when no email is published: their author page, else the outlet's contact page or site. */
const findContactUrl = (j: Journalist) => j.contactPage || j.outletContactPage || (j.outletDomain ? `https://${j.outletDomain}/` : null);

function JournalistRow({ j, onView }: { j: Row; onView: (v: View) => void }) {
  const { busy, error, act } = useAct(onView);
  const draft = j.pitchEdit ?? (j.pitch ? { subject: j.pitch.subject, body: j.pitch.body } : null);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const [notes, setNotes] = useState(j.notes ?? "");
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    setSubject(draft?.subject ?? "");
    setBody(draft?.body ?? "");
  }, [draft?.subject, draft?.body]);
  const contact = findContactUrl(j);
  const href = mailtoFor(j.email, draft?.subject ?? "", draft?.body ?? "");
  return (
    <div className={`rounded-xl border p-4 ${j.due ? "border-dash-copper" : "border-dash-line"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-dash-ink">
            {j.name}
            {j.jobTitle ? (
              <span className="font-normal text-dash-muted">
                {" "}
                · {j.jobTitle}
                {j.jobTitleFromHunter ? " (from Hunter)" : ""}
              </span>
            ) : null}
          </p>
          <p className="text-sm text-dash-ink">{j.outlet}</p>
          {j.articleUrl && (
            <a href={j.articleUrl} target="_blank" rel="noreferrer" className="block break-words text-sm text-dash-green hover:underline [overflow-wrap:anywhere]">
              {j.articleTitle || j.articleUrl}
            </a>
          )}
        </div>
        <select
          aria-label="Status"
          value={j.status}
          disabled={busy !== null}
          onChange={(e) => act("status", { action: "status", id: j.id, status: e.target.value })}
          className="rounded-lg border border-dash-line bg-white px-2 py-1 text-xs text-dash-ink"
        >
          {CRM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-2 break-words text-sm text-dash-ink [overflow-wrap:anywhere]">
        {j.email ? (
          <span>
            {j.email}
            {j.emailSource === "hunter" ? ` (found by Hunter, score ${j.hunterScore ?? "unknown"})` : j.emailIsOutlets ? " (the outlet's email)" : ""}
          </span>
        ) : null}
        {j.email && j.phone ? " · " : null}
        {j.phone ? <span>{j.phone}{j.phoneIsOutlets ? " (the outlet's phone)" : ""}</span> : null}
        {!j.email && contact ? (
          <>
            {j.phone ? " · " : null}
            <a href={contact} target="_blank" rel="noreferrer" className="text-dash-green hover:underline">
              Find contact on {j.outlet}
            </a>
          </>
        ) : null}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dash-muted">
        <span>Last contacted: {dayText(j.lastContacted) ?? "never"}</span>
        <label className="flex items-center gap-1">
          Follow up
          <input
            type="date"
            value={j.followUp ?? ""}
            disabled={busy !== null}
            onChange={(e) => act("followUp", { action: "followUp", id: j.id, date: e.target.value || null })}
            className="rounded border border-dash-line bg-white px-1 py-0.5 text-xs text-dash-ink"
          />
        </label>
        {j.due && <span className="font-semibold text-dash-copper">Follow up today</span>}
      </div>
      {draft && !editing && (
        <div className="mt-3">
          <p className="text-sm font-semibold text-dash-ink">{draft.subject}</p>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-dash-bg p-3 text-sm text-dash-ink [overflow-wrap:anywhere]">{draft.body}</p>
          <p className="mt-1 text-xs text-dash-muted">{j.pitchEdit ? "Your edit." : "Checked by a second AI."} It opens in your own email app, where you can change it before you send.</p>
        </div>
      )}
      {editing && (
        <div className="mt-3 space-y-2">
          <input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} className={input} />
          <textarea aria-label="Email" value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={input} />
          <div className="flex gap-2">
            <button className={primary} disabled={busy !== null} onClick={() => act("edit", { action: "edit", id: j.id, subject, body }).then(() => setEditing(false))}>
              Save
            </button>
            <button className={btn} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!draft && j.pitchNote && <p className="mt-2 text-xs text-dash-muted">{j.pitchNote}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a href={href} target={isEmbedded() ? "_top" : undefined} className={primary} onClick={() => setAsking(true)}>
          Email
        </a>
        {draft && <Copy text={`${draft.subject}\n\n${draft.body}`} />}
        {draft && !editing && (
          <button className={btn} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {!draft && (
          <button className={btn} disabled={busy !== null} onClick={() => act("pitch", { action: "pitch", id: j.id })}>
            {busy === "pitch" ? "Writing" : "Write a draft"}
          </button>
        )}
      </div>
      {asking && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-dash-bg p-2 text-sm text-dash-ink">
          Did you send it?
          <button className={primary} disabled={busy !== null} onClick={() => act("emailed", { action: "emailed", id: j.id }).then(() => setAsking(false))}>
            Yes
          </button>
          <button className={btn} onClick={() => setAsking(false)}>
            No
          </button>
        </div>
      )}
      <textarea
        aria-label="Notes"
        placeholder="Notes"
        value={notes}
        maxLength={500}
        rows={2}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => notes !== (j.notes ?? "") && act("notes", { action: "notes", id: j.id, notes })}
        className={`mt-3 ${input}`}
      />
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </div>
  );
}

const EMPTY = { name: "", jobTitle: "", outlet: "", email: "", phone: "", articleUrl: "", articleTitle: "" };

function AddJournalist({ onView, onDone }: { onView: (v: View) => void; onDone: () => void }) {
  const [f, setF] = useState(EMPTY);
  const { busy, error, act } = useAct((v) => {
    onView(v);
    setF(EMPTY);
    onDone();
  });
  const field = (k: keyof typeof EMPTY, label: string, type = "text") => (
    <label className="text-xs text-dash-muted">
      {label}
      <input type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className={input} />
    </label>
  );
  return (
    <div className="mb-4 grid grid-cols-1 gap-2 rounded-xl border border-dash-line p-4 sm:grid-cols-2">
      {field("name", "Full name")}
      {field("jobTitle", "Job title")}
      {field("outlet", "Where they publish")}
      {field("email", "Email", "email")}
      {field("phone", "Phone", "tel")}
      {field("articleTitle", "Their article")}
      {field("articleUrl", "Article link", "url")}
      <div className="flex items-end gap-2">
        <button className={primary} disabled={busy !== null} onClick={() => act("add", { action: "add", ...f })}>
          Add
        </button>
        <button className={btn} onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <p className="text-sm text-dash-down sm:col-span-2">{error}</p>}
    </div>
  );
}

function downloadCsv(rows: Row[]) {
  const blob = new Blob([journalistsCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "journalists.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RequestCard({ r, onView }: { r: MediaRequest; onView: (v: View) => void }) {
  const { busy, error, act } = useAct(onView);
  return (
    <div className="rounded-xl border border-dash-line p-4">
      <a href={r.url} target="_blank" rel="noreferrer" className="block break-words font-semibold text-dash-green hover:underline [overflow-wrap:anywhere]">
        {r.title}
      </a>
      <p className="text-xs text-dash-muted">
        {r.platform}
        {r.deadline ? ` · Deadline ${r.deadline}` : ""}
      </p>
      {r.snippet && <p className="mt-1 break-words text-sm text-dash-ink [overflow-wrap:anywhere]">{r.snippet}</p>}
      {r.answer ? (
        <>
          <p className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-dash-bg p-3 text-sm text-dash-ink [overflow-wrap:anywhere]">{r.answer.text}</p>
          <p className="mt-1 break-words text-xs text-dash-muted">From your page {r.answer.page}. Checked by a second AI. Submit it yourself on their site.</p>
        </>
      ) : (
        r.answerNote && <p className="mt-2 text-xs text-dash-muted">{r.answerNote}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!r.answer && (
          <button className={primary} disabled={busy !== null} onClick={() => act("answer", { action: "answer", url: r.url })}>
            {busy === "answer" ? "Writing" : "Draft an answer"}
          </button>
        )}
        {r.answer && <Copy text={r.answer.text} />}
        <button className={btn} disabled={busy !== null} onClick={() => act("dismiss", { action: "dismiss-request", url: r.url })}>
          Dismiss
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </div>
  );
}

function PaidCard({ p, onView }: { p: PaidOpportunity; onView: (v: View) => void }) {
  const { busy, act } = useAct(onView);
  return (
    <div className="rounded-xl border border-dash-line p-4">
      <p className="font-semibold text-dash-ink break-words [overflow-wrap:anywhere]">{p.outlet}</p>
      <p className="text-xs text-dash-muted">
        {p.type[0].toUpperCase() + p.type.slice(1)} · {p.price ? `Price on their page: ${p.price}` : "No price on their page"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a href={p.url} target="_blank" rel="noreferrer" className={btn}>
          See their advertising page
        </a>
        <button className={btn} disabled={busy !== null} onClick={() => act("dismiss", { action: "dismiss-paid", url: p.url })}>
          Dismiss
        </button>
      </div>
    </div>
  );
}


/**
 * The Outreach tab: one simple journalist list. Each journalist with their job title, outlet, contact and article, a
 * status, notes and a follow up day. Email opens the owner's own email app; DashPatrol never sends anything. Advanced
 * also shows media requests and paid opportunities.
 */
export function Outreach({ advanced = false }: { advanced?: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [onlyDue, setOnlyDue] = useState(false);
  const [adding, setAdding] = useState(false);
  const { busy, error, act } = useAct(setView);
  useEffect(() => {
    api<View>("/api/outreach").then(setView).catch(() => setView(null));
  }, []);
  if (!view) return null;
  const rows = onlyDue ? view.journalists.filter((j) => j.due) : view.journalists;
  return (
    <>
      <Card className="mt-6">
        <CardHeader title="Journalists" />
        <p className="mb-3 text-xs text-dash-muted">
          People who recently wrote about {view.topics.length ? view.topics.join(", ") : "your products"}, as printed on their article. Email opens your own email
          app; DashPatrol never sends anything. Up to {view.cap} new drafts a week ({view.draftsLeft} left).
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button className={onlyDue ? primary : btn} onClick={() => setOnlyDue((v) => !v)}>
            Follow up today ({view.followUpsToday})
          </button>
          <button className={btn} onClick={() => setAdding((v) => !v)}>
            Add journalist
          </button>
          <button className={btn} disabled={!view.canFindNow || busy !== null} onClick={() => act("find", { action: "find" })}>
            {busy === "find" ? "Looking, this takes a minute" : "Find more now"}
          </button>
          <button className={btn} disabled={!view.journalists.length} onClick={() => downloadCsv(view.journalists)}>
            Download CSV
          </button>
          {!view.canFindNow && <span className="text-xs text-dash-muted">Find more works once a day.</span>}
        </div>
        {error && <p className="mb-3 text-sm text-dash-down">{error}</p>}
        {adding && <AddJournalist onView={setView} onDone={() => setAdding(false)} />}
        {rows.length ? (
          <div className="space-y-3">
            {rows.map((j) => (
              <JournalistRow key={j.id} j={j} onView={setView} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-dash-muted">{onlyDue ? "No follow ups due today." : (view.lastRun.press ?? "The first search for journalists runs within the week.")}</p>
        )}
      </Card>

      {advanced && (
        <>
          <Card className="mt-6">
            <CardHeader title="Media requests" />
            <p className="mb-3 text-xs text-dash-muted">Public requests where journalists ask for sources on your topics. Answer before the deadline, on their site.</p>
            {view.requests.length > 0 && (
              <div className="space-y-3">
                {view.requests.map((r) => (
                  <RequestCard key={r.url} r={r} onView={setView} />
                ))}
              </div>
            )}
            {view.requestsNote && (
              <div className="text-sm text-dash-ink">
                <p>{view.requestsNote}</p>
                <ul className="mt-2 list-inside list-disc">
                  {view.platforms.map((p) => (
                    <li key={p.host}>
                      <a href={p.url} target="_blank" rel="noreferrer" className="text-dash-green hover:underline">
                        {p.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          <Card className="mt-6">
            <CardHeader title="Paid opportunities" />
            <p className="mb-3 rounded-lg bg-dash-bg p-2 text-xs text-dash-ink">{view.paidNote}</p>
            {view.paid.length ? (
              <div className="space-y-3">
                {view.paid.map((p) => (
                  <PaidCard key={p.url} p={p} onView={setView} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-dash-muted">No paid placements on your topics were found yet.</p>
            )}
          </Card>
        </>
      )}
    </>
  );
}
