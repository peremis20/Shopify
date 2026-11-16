"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { MediaRequest, PaidOpportunity } from "@/lib/analytics/autopilot/press";
import type { ListedJournalist, ListQuery, Template } from "@/lib/analytics/autopilot/press-list";
import {
  composeCurrent,
  composeDone,
  composeStart,
  composeStep,
  CRM_STATUSES,
  fillTemplate,
  journalistsCsv,
  mailtoFor,
  MERGE_FIELDS,
  STATUS_LABEL,
  type ComposeState,
  type CrmMetrics,
  type CrmStatus,
} from "@/lib/analytics/autopilot/press-crm";
import {
  dedupeKey,
  guessColumns,
  IMPORT_CHUNK,
  IMPORT_FIELD_LABEL,
  IMPORT_MAX_ROWS,
  parseCsv,
  planImport,
  rejectsCsv,
  rowValues,
  type ImportField,
  type Reject,
} from "@/lib/analytics/autopilot/press-import";
import { isEmbedded } from "./embedded-client";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";

type Row = ListedJournalist;

interface View {
  journalists: Row[];
  total: number;
  page: number;
  pageSize: number;
  query: ListQuery;
  facets: { tags: string[]; fields: string[] };
  templates: Template[];
  metrics: CrmMetrics;
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

const btn = "rounded-lg border border-dash-line bg-white px-3 py-1.5 text-xs font-semibold text-dash-ink hover:border-dash-green disabled:opacity-60";
const primary = "rounded-lg bg-dash-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-dash-deep disabled:opacity-60";
const input = "w-full rounded-lg border border-dash-line bg-white px-2 py-1.5 text-sm text-dash-ink";
const select = "rounded-lg border border-dash-line bg-white px-2 py-1.5 text-xs text-dash-ink";
const dayText = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString() : null);
const timeText = (t: string | null | undefined) => {
  const d = t ? new Date(t) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString() : "";
};

/** The list's current search, filters, sort and page: every action sends it, so the answer is the same page refreshed. */
const QueryCtx = createContext<Partial<ListQuery>>({});

/** Runs one action and keeps its error for the caller to show. */
function useAct(onView: (v: View) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useContext(QueryCtx);
  const act = async (key: string, body: Record<string, unknown>): Promise<boolean> => {
    setBusy(key);
    setError(null);
    try {
      onView(await api<View>("/api/outreach", { ...body, query }));
      setBusy(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't do that. Try again.");
      setBusy(null);
      return false;
    }
  };
  return { busy, error, act };
}

function saveFile(name: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const toQueryString = (q: Partial<ListQuery>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== null && v !== undefined && v !== false && v !== "" && !(k === "page" && v === 0) && !(k === "sort" && v === "recent")) p.set(k, String(v));
  return p.toString();
};

const PILL: Record<CrmStatus, string> = {
  new: "bg-slate-100 text-slate-700",
  emailed: "bg-sky-100 text-sky-800",
  replied: "bg-amber-100 text-amber-800",
  covered: "bg-emerald-100 text-emerald-800",
  not_interested: "bg-rose-50 text-rose-700",
};

function StatusPill({ s }: { s: CrmStatus }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${PILL[s]}`}>{STATUS_LABEL[s]}</span>;
}

/** Where to look for a contact when no email is published: their author page, else the outlet's contact page or site. */
const findContactUrl = (j: Row) => j.contactPage || j.outletContactPage || (j.outletDomain ? `https://${j.outletDomain}/` : null);

/** Someone's email as shown, with where it came from when it isn't printed by them. */
const emailLabel = (j: Row) =>
  j.email ? `${j.email}${j.emailSource === "hunter" ? ` (found by Hunter, score ${j.hunterScore ?? "unknown"})` : j.emailIsOutlets ? " (the outlet's email)" : ""}` : null;

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

const EMPTY = { name: "", jobTitle: "", outlet: "", email: "", phone: "", location: "", field: "", profileUrl: "", articleUrl: "", articleTitle: "", notes: "" };

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
      {field("location", "Location")}
      {field("field", "Industry or field")}
      {field("profileUrl", "Profile link", "url")}
      {field("articleTitle", "Their article")}
      {field("articleUrl", "Article link", "url")}
      {field("notes", "Notes")}
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

function Tile({ label, value, sub, active, onClick }: { label: string; value: number; sub?: React.ReactNode; active?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <p className="text-xs text-dash-muted">{label}</p>
      <p className="text-2xl font-semibold tabular-nums text-dash-ink">{value.toLocaleString()}</p>
      {sub ? <p className="text-xs text-dash-muted">{sub}</p> : null}
    </>
  );
  const cls = `min-w-0 rounded-xl border p-3 text-left ${active ? "border-dash-green bg-dash-bg" : "border-dash-line"}`;
  return onClick ? (
    <button onClick={onClick} className={`${cls} hover:border-dash-green`} aria-pressed={active}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** The numbers above the list, counted on the server from the list itself. A tile with nothing to count shows 0. */
function MetricsStrip({ m, filter, onFilter }: { m: CrmMetrics; filter: "due" | "covered" | null; onFilter: (f: "due" | "covered") => void }) {
  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Total contacts" value={m.total} sub={`${m.newThisWeek} new this week`} />
        <Tile label="Emailed" value={m.emailedThisWeek} sub={`this week, ${m.emailedEver} in all`} />
        <Tile label="Replies" value={m.replies} sub={m.replyRate !== null ? `${m.replyRate}% reply rate` : null} />
        <Tile
          label="Coverage"
          value={m.coverage}
          sub={<span className="font-semibold text-dash-green">{filter === "covered" ? "Show all" : "See them"}</span>}
          active={filter === "covered"}
          onClick={() => onFilter("covered")}
        />
        <Tile label="Follow up today" value={m.followUpsToday} active={filter === "due"} onClick={() => onFilter("due")} />
        <Tile label="Ready to send" value={m.readyToSend} sub="drafts waiting" />
      </div>
      <p className="mt-2 break-words text-xs text-dash-muted">
        Found {m.funnel.found} → Emailed {m.funnel.emailed} → Replied {m.funnel.replied} → Covered {m.funnel.covered}
      </p>
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

/** The owner's spreadsheet: pick the file, check the column guesses, see what will happen, then import. */
function ImportCsv({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ImportField[]>([]);
  const [tag, setTag] = useState("");
  const [existing, setExisting] = useState<number | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ added: number; duplicates: number; rejects: Reject[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = useMemo(() => (rows.length ? planImport(rows, mapping) : null), [rows, mapping]);

  // How many of the rows to add are already on the list (asked once the guesses settle).
  useEffect(() => {
    if (!plan?.add.length) return setExisting(plan ? 0 : null);
    setExisting(null);
    const t = setTimeout(() => {
      api<{ existing: number }>("/api/outreach", { action: "import-check", keys: plan.add.map(dedupeKey) })
        .then((r) => setExisting(r.existing))
        .catch(() => setExisting(null));
    }, 400);
    return () => clearTimeout(t);
  }, [plan]);

  const pick = async (file: File | undefined) => {
    setError(null);
    setResult(null);
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && !/csv|text\/plain/.test(file.type)) return setError("Please save the spreadsheet as CSV first, then pick that file.");
    const all = parseCsv(await file.text());
    if (all.length < 2) return setError("The file has no rows under its header.");
    if (all.length - 1 > IMPORT_MAX_ROWS) return setError(`The file has ${(all.length - 1).toLocaleString()} rows. Import up to ${IMPORT_MAX_ROWS.toLocaleString()} at a time.`);
    setHeaders(all[0]);
    setRows(all.slice(1));
    setMapping(guessColumns(all[0]));
  };

  const run = async () => {
    if (!plan) return;
    setError(null);
    const out = { added: 0, duplicates: plan.duplicates, rejects: [...plan.rejects] };
    try {
      for (let i = 0; i < plan.add.length; i += IMPORT_CHUNK) {
        setProgress(`Adding ${Math.min(i + IMPORT_CHUNK, plan.add.length).toLocaleString()} of ${plan.add.length.toLocaleString()}`);
        const r = await api<{ added: number; duplicates: number; rejects: Reject[] }>("/api/outreach", { action: "import", tag, rows: plan.add.slice(i, i + IMPORT_CHUNK).map(rowValues) });
        out.added += r.added;
        out.duplicates += r.duplicates;
        out.rejects.push(...r.rejects.map((x) => ({ ...x, line: 0 })));
      }
      setResult(out);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import stopped. Rows added so far stay; try the rest again.");
      setResult(out);
    }
    setProgress(null);
  };

  const preview = plan?.add.slice(0, 5) ?? [];
  const willAdd = plan ? Math.max(0, plan.add.length - (existing ?? 0)) : 0;
  return (
    <div className="mb-4 rounded-xl border border-dash-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-dash-ink">Import journalists from a spreadsheet</p>
        <button className={btn} onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-1 text-xs text-dash-muted">Use a CSV file. In Excel or Google Sheets, save or download it as CSV first. Up to {IMPORT_MAX_ROWS.toLocaleString()} rows.</p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} className="mt-2 block w-full text-sm" />
      {headers.length > 0 && !result && (
        <>
          <p className="mt-3 text-sm font-semibold text-dash-ink">Match the columns</p>
          <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {headers.map((h, i) => (
              <label key={i} className="flex items-center justify-between gap-2 text-xs text-dash-ink">
                <span className="min-w-0 truncate">{h || `Column ${i + 1}`}</span>
                <select
                  value={mapping[i]}
                  onChange={(e) => setMapping(mapping.map((m, k) => (k === i ? (e.target.value as ImportField) : m)))}
                  className="rounded-lg border border-dash-line bg-white px-2 py-1 text-xs"
                >
                  {(Object.keys(IMPORT_FIELD_LABEL) as ImportField[]).map((f) => (
                    <option key={f} value={f}>
                      {IMPORT_FIELD_LABEL[f]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <label className="mt-3 block text-xs text-dash-muted">
            List name (optional, for example &quot;Help a Reporter November&quot;)
            <input value={tag} maxLength={60} onChange={(e) => setTag(e.target.value)} className={input} />
          </label>
          {plan && (
            <>
              <p className="mt-3 text-sm text-dash-ink">
                Will add {existing === null ? "…" : willAdd.toLocaleString()} · Duplicates {existing === null ? "…" : (plan.duplicates + existing).toLocaleString()} · Invalid{" "}
                {plan.rejects.length.toLocaleString()}
              </p>
              {preview.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-dash-muted">
                      <tr>
                        <th className="py-1 pr-2">Name</th>
                        <th className="py-1 pr-2">Outlet</th>
                        <th className="py-1 pr-2">Email</th>
                        <th className="hidden py-1 pr-2 sm:table-cell">Location</th>
                        <th className="hidden py-1 pr-2 sm:table-cell">Field</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((r, i) => (
                        <tr key={i} className="border-t border-dash-line">
                          <td className="py-1 pr-2">{r.name}</td>
                          <td className="py-1 pr-2">{r.outlet}</td>
                          <td className="py-1 pr-2 break-all">{r.email ?? ""}</td>
                          <td className="hidden py-1 pr-2 sm:table-cell">{r.location ?? ""}</td>
                          <td className="hidden py-1 pr-2 sm:table-cell">{r.field ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={primary} disabled={progress !== null || !plan.add.length} onClick={run}>
                  {progress ?? `Import ${plan.add.length.toLocaleString()} rows`}
                </button>
                {plan.rejects.length > 0 && (
                  <button className={btn} onClick={() => saveFile("skipped rows.csv", rejectsCsv(headers, plan.rejects))}>
                    Download skipped rows
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
      {result && (
        <div className="mt-3 text-sm text-dash-ink">
          <p>
            Added {result.added.toLocaleString()} · Duplicates {result.duplicates.toLocaleString()} · Skipped {result.rejects.length.toLocaleString()}
          </p>
          {result.rejects.length > 0 && (
            <button className={`mt-2 ${btn}`} onClick={() => saveFile("skipped rows.csv", rejectsCsv(headers, result.rejects))}>
              Download skipped rows
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </div>
  );
}

/** A panel that slides in from the right; full width on phones. */
function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div role="dialog" aria-label={title} className="flex h-full w-full max-w-lg flex-col bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-dash-line px-4 py-3">
          <p className="truncate font-semibold text-dash-ink">{title}</p>
          <button className={btn} onClick={onClose}>
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 text-sm">
      <span className="text-xs text-dash-muted">{label}</span>
      <span className="col-span-2 min-w-0 break-words text-dash-ink [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

/** One journalist's full details: contact, links, status, follow up, notes, their AI draft and history. */
function DetailsDrawer({ j, onView, onEmail, onClose }: { j: Row; onView: (v: View) => void; onEmail: (ids: string[]) => void; onClose: () => void }) {
  const { busy, error, act } = useAct(onView);
  const draft = j.pitchEdit ?? (j.pitch ? { subject: j.pitch.subject, body: j.pitch.body } : null);
  const [notes, setNotes] = useState(j.notes ?? "");
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const contact = findContactUrl(j);
  const history = [...j.history].reverse();
  return (
    <Drawer title={j.name} onClose={onClose}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-dash-ink">
            {j.jobTitle ? `${j.jobTitle}${j.jobTitleFromHunter ? " (from Hunter)" : ""}, ` : ""}
            {j.outlet}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="Status" value={j.status} disabled={busy !== null} onChange={(e) => act("status", { action: "status", id: j.id, status: e.target.value })} className={select}>
            {CRM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button className={primary} onClick={() => onEmail([j.id])}>
            Email
          </button>
        </div>
      </div>

      <div className="mt-4 divide-y divide-dash-line">
        <Detail label="Email">
          {emailLabel(j) ??
            (contact ? (
              <a href={contact} target="_blank" rel="noreferrer" className="text-dash-green hover:underline">
                Find contact on {j.outlet}
              </a>
            ) : (
              "None published"
            ))}
        </Detail>
        <Detail label="Phone">{j.phone ? `${j.phone}${j.phoneIsOutlets ? " (the outlet's phone)" : ""}` : "None published"}</Detail>
        <Detail label="Location">{j.location || "Not given"}</Detail>
        <Detail label="Field">{j.field || "Not given"}</Detail>
        {j.tags.length > 0 && <Detail label="Lists">{j.tags.join(", ")}</Detail>}
        <Detail label="Links">
          <span className="flex flex-col gap-0.5">
            {j.articleUrl ? (
              <a href={j.articleUrl} target="_blank" rel="noreferrer" className="text-dash-green hover:underline">
                {j.articleTitle || "Their article"}
              </a>
            ) : null}
            {j.profileUrl ? (
              <a href={j.profileUrl} target="_blank" rel="noreferrer" className="text-dash-green hover:underline">
                Profile
              </a>
            ) : null}
            {j.contactPage ? (
              <a href={j.contactPage} target="_blank" rel="noreferrer" className="text-dash-green hover:underline">
                Their page on {j.outlet}
              </a>
            ) : null}
            {!j.articleUrl && !j.profileUrl && !j.contactPage ? "None" : null}
          </span>
        </Detail>
        <Detail label="Last contacted">{dayText(j.lastContacted) ?? "Never"}</Detail>
        <Detail label="Follow up">
          <input
            type="date"
            aria-label="Follow up"
            value={j.followUp ?? ""}
            disabled={busy !== null}
            onChange={(e) => act("followUp", { action: "followUp", id: j.id, date: e.target.value || null })}
            className="rounded border border-dash-line bg-white px-1 py-0.5 text-sm"
          />
        </Detail>
      </div>

      <label className="mt-4 block text-xs text-dash-muted">
        Notes
        <textarea
          value={notes}
          maxLength={500}
          rows={3}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (j.notes ?? "") && act("notes", { action: "notes", id: j.id, notes })}
          className={`mt-1 ${input}`}
        />
      </label>

      <div className="mt-4">
        <p className="text-xs text-dash-muted">AI draft</p>
        {draft && !editing && (
          <div className="mt-1 rounded-lg border border-dash-line p-3">
            <p className="text-sm font-semibold text-dash-ink">{draft.subject}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-dash-ink">{draft.body}</p>
            <p className="mt-2 text-xs text-dash-muted">{j.pitchEdit ? "Your edit." : "Checked by a second AI."}</p>
            <div className="mt-2 flex gap-2">
              <button className={btn} onClick={() => setEditing(true)}>
                Edit
              </button>
              <Copy text={`${draft.subject}\n\n${draft.body}`} />
            </div>
          </div>
        )}
        {editing && (
          <div className="mt-1 space-y-2">
            <input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} className={input} />
            <textarea aria-label="Email" value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={input} />
            <div className="flex gap-2">
              <button className={primary} disabled={busy !== null} onClick={() => act("edit", { action: "edit", id: j.id, subject, body }).then((ok) => ok && setEditing(false))}>
                Save
              </button>
              <button className={btn} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {!draft && (
          <div className="mt-1">
            {j.pitchNote && <p className="text-xs text-dash-muted">{j.pitchNote}</p>}
            <button className={`mt-1 ${btn}`} disabled={busy !== null} onClick={() => act("pitch", { action: "pitch", id: j.id })}>
              {busy === "pitch" ? "Writing" : "Write an AI draft"}
            </button>
          </div>
        )}
      </div>

      <div className="mt-4">
        <p className="text-xs text-dash-muted">History</p>
        <ul className="mt-1 space-y-1 text-sm text-dash-ink">
          {history.map((h, i) => (
            <li key={i}>
              {timeText(h.at)}: {h.status === "emailed" ? "Emailed" : `Status set to ${STATUS_LABEL[h.status] ?? h.status}`}
            </li>
          ))}
          <li className="text-dash-muted">
            {timeText(j.foundAt)}: {j.source === "owner" ? "Added by you" : "Found by the journalist search"}
          </li>
        </ul>
      </div>
      {error && <p className="mt-3 text-sm text-dash-down">{error}</p>}
    </Drawer>
  );
}

/**
 * One compose panel for the selected people. Each person gets their own email, opened one at a time in the owner's own
 * email app ("1 of 5"), filled from a template with merge fields, or from their own AI draft. Each is marked Emailed only
 * after the owner says they sent it. DashPatrol never sends anything.
 */
function ComposeDrawer({ people, templates, onView, onClose }: { people: Row[]; templates: Template[]; onView: (v: View) => void; onClose: () => void }) {
  const withEmail = people.filter((p) => p.email);
  const noEmail = people.filter((p) => !p.email);
  const [state, setState] = useState<ComposeState>(() => composeStart(withEmail.map((p) => p.id)));
  const [choice, setChoice] = useState<string>(() => (withEmail.some((p) => p.pitchEdit || p.pitch) ? "ai" : "blank"));
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [tplName, setTplName] = useState("");
  const [copied, setCopied] = useState(false);
  const { busy, error, act } = useAct(onView);
  const pick = (c: string) => {
    setChoice(c);
    const t = templates.find((x) => x.id === c);
    if (t) {
      setSubject(t.subject);
      setBody(t.body);
      setTplName(t.name);
    } else if (c === "blank") {
      setSubject("");
      setBody("");
      setTplName("");
    }
  };
  const current = withEmail.find((p) => p.id === composeCurrent(state)) ?? null;
  // The email for the current person: their own AI draft, or the template filled with their merge fields.
  const own = current ? (current.pitchEdit ?? (current.pitch ? { subject: current.pitch.subject, body: current.pitch.body } : null)) : null;
  const filledSubject = current ? (choice === "ai" ? { text: own?.subject ?? "", missing: [] } : fillTemplate(subject, current)) : null;
  const filledBody = current ? (choice === "ai" ? { text: own?.body ?? "", missing: [] } : fillTemplate(body, current)) : null;
  const missing = [...new Set([...(filledSubject?.missing ?? []), ...(filledBody?.missing ?? [])])];
  const noDraft = choice === "ai" && current && !own;
  const href = current && filledSubject && filledBody ? mailtoFor(current.email, filledSubject.text, filledBody.text) : "#";
  const saveTemplate = (id: string | null) => act("template", { action: "template-save", template: { id, name: tplName, subject, body } });
  return (
    <Drawer title={people.length === 1 ? `Email ${people[0].name}` : `Email ${people.length} people`} onClose={onClose}>
      <div className="text-sm">
        <p className="text-xs text-dash-muted">To</p>
        <p className="mt-1 break-words text-dash-ink">{withEmail.map((p) => p.name).join(", ") || "Nobody with an email"}</p>
        {noEmail.length > 0 && <p className="mt-1 text-xs text-dash-muted">No email for {noEmail.map((p) => p.name).join(", ")}. Open their details to find a contact.</p>}
        {withEmail.length > 1 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              className={btn}
              onClick={() =>
                navigator.clipboard
                  .writeText(withEmail.map((p) => p.email).join(", "))
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => undefined)
              }
            >
              {copied ? "Copied" : "Copy all emails"}
            </button>
            <span className="text-xs text-dash-muted">For BCC. Personal emails, one per person, get better replies.</span>
          </div>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <label className="block text-xs text-dash-muted">
          Template
          <select value={choice} onChange={(e) => pick(e.target.value)} className={`mt-1 w-full ${select}`}>
            <option value="ai">Each person&apos;s AI draft</option>
            <option value="blank">Blank</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {choice !== "ai" && (
          <>
            <input aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} className={input} />
            <textarea aria-label="Body" placeholder="Hi {first_name}," value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={input} />
            <div className="flex flex-wrap gap-1">
              {MERGE_FIELDS.map((f) => (
                <button key={f} className="rounded-full border border-dash-line px-2 py-0.5 text-xs text-dash-ink hover:border-dash-green" onClick={() => setBody((b) => `${b}{${f}}`)}>
                  {`{${f}}`}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input aria-label="Template name" placeholder="Template name" value={tplName} maxLength={60} onChange={(e) => setTplName(e.target.value)} className="w-40 rounded-lg border border-dash-line px-2 py-1 text-xs" />
              <button className={btn} disabled={busy !== null || !tplName.trim()} onClick={() => saveTemplate(null)}>
                Save as new template
              </button>
              {templates.some((t) => t.id === choice) && (
                <>
                  <button className={btn} disabled={busy !== null} onClick={() => saveTemplate(choice)}>
                    Update template
                  </button>
                  <button className={btn} disabled={busy !== null} onClick={() => act("template", { action: "template-delete", templateId: choice }).then((ok) => ok && pick("blank"))}>
                    Delete template
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="mt-5 rounded-xl border border-dash-line p-3">
        {composeDone(state) || !current ? (
          <div className="text-sm text-dash-ink">
            <p className="font-semibold">All done.</p>
            <p className="mt-1 text-dash-muted">
              {state.sent.length} marked Emailed{state.skipped.length ? `, ${state.skipped.length} skipped` : ""}.
            </p>
            <button className={`mt-2 ${btn}`} onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <>
            <p className="text-xs text-dash-muted">
              {state.index + 1} of {state.ids.length}
            </p>
            <p className="text-sm font-semibold text-dash-ink">
              {current.name} <span className="font-normal text-dash-muted">{current.email}</span>
            </p>
            {noDraft ? (
              <p className="mt-2 text-sm text-dash-muted">No AI draft for {current.name} yet. Pick a template, or open their details to write one.</p>
            ) : (
              <>
                <p className="mt-2 text-sm font-semibold text-dash-ink">{filledSubject?.text}</p>
                <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-dash-bg p-2 text-sm text-dash-ink">{filledBody?.text}</p>
                {missing.length > 0 && <p className="mt-1 text-xs text-dash-copper">Nothing to fill for {missing.map((m) => `{${m}}`).join(", ")} here. Check it in your email app.</p>}
              </>
            )}
            {!state.opened ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href={noDraft ? undefined : href}
                  target={isEmbedded() ? "_top" : undefined}
                  aria-disabled={Boolean(noDraft)}
                  onClick={(e) => (noDraft ? e.preventDefault() : setState((s) => composeStep(s, "opened")))}
                  className={`${primary} ${noDraft ? "pointer-events-none opacity-60" : ""}`}
                >
                  Open in my email
                </a>
                <button className={btn} onClick={() => setState((s) => composeStep(s, "skip"))}>
                  Skip
                </button>
                {state.index > 0 && (
                  <button className={btn} onClick={() => setState((s) => composeStep(s, "back"))}>
                    Back
                  </button>
                )}
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-dash-ink">
                Did you send it?
                <button
                  className={primary}
                  disabled={busy !== null}
                  onClick={() => act("emailed", { action: "emailed", id: current.id }).then((ok) => ok && setState((s) => composeStep(s, "sent")))}
                >
                  Yes, next
                </button>
                <button className={btn} onClick={() => setState((s) => composeStep(s, "notSent"))}>
                  No
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-dash-down">{error}</p>}
    </Drawer>
  );
}

/** The actions for the selected people: email them, set a status, add a list name, export, delete the ones you added. */
function SelectionBar({ ids, rows, onView, onClear, onEmail }: { ids: string[]; rows: Row[]; onView: (v: View) => void; onClear: () => void; onEmail: () => void }) {
  const { busy, error, act } = useAct(onView);
  const [tag, setTag] = useState("");
  const [tagging, setTagging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ownerCount = rows.filter((r) => ids.includes(r.id) && r.source === "owner").length;
  const exportSelected = async () => {
    const r = await api<{ rows: Row[] }>("/api/outreach", { action: "export", ids });
    saveFile("journalists.csv", journalistsCsv(r.rows));
  };
  return (
    <div className="sticky top-0 z-20 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-dash-green bg-white p-2 text-xs text-dash-ink shadow-sm">
      <span className="font-semibold">{ids.length} selected</span>
      <button className={primary} onClick={onEmail}>
        Email selected
      </button>
      <select
        aria-label="Set status"
        value=""
        disabled={busy !== null}
        onChange={(e) => e.target.value && act("status", { action: "bulk", ids, bulk: { kind: "status", status: e.target.value } })}
        className={select}
      >
        <option value="">Set status</option>
        {CRM_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      {!tagging ? (
        <button className={btn} onClick={() => setTagging(true)}>
          Tag
        </button>
      ) : (
        <span className="flex items-center gap-1">
          <input aria-label="List name" placeholder="List name" autoFocus value={tag} maxLength={60} onChange={(e) => setTag(e.target.value)} className="w-32 rounded-lg border border-dash-line px-2 py-1" />
          <button
            className={btn}
            disabled={!tag.trim() || busy !== null}
            onClick={() => act("tag", { action: "bulk", ids, bulk: { kind: "tag", tag } }).then((ok) => ok && (setTag(""), setTagging(false)))}
          >
            Add
          </button>
        </span>
      )}
      <button className={btn} onClick={exportSelected}>
        Export
      </button>
      {!confirming ? (
        <button className={btn} disabled={!ownerCount} onClick={() => setConfirming(true)} title="Only people you added or imported can be deleted">
          Delete
        </button>
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          Delete {ownerCount} you added? Found journalists stay.
          <button className={primary} disabled={busy !== null} onClick={() => act("delete", { action: "bulk", ids, bulk: { kind: "delete" } }).then((ok) => ok && (setConfirming(false), onClear()))}>
            Yes, delete
          </button>
          <button className={btn} onClick={() => setConfirming(false)}>
            No
          </button>
        </span>
      )}
      <button className="ml-auto text-xs font-semibold text-dash-green hover:underline" onClick={onClear}>
        Clear
      </button>
      {error && <span className="w-full text-dash-down">{error}</span>}
    </div>
  );
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


const SORTS: { id: ListQuery["sort"]; label: string }[] = [
  { id: "recent", label: "Newest" },
  { id: "name", label: "Name" },
  { id: "outlet", label: "Outlet" },
  { id: "status", label: "Status" },
  { id: "last", label: "Last contacted" },
];

/**
 * The Outreach tab: the journalist list as one compact table, searched, filtered, sorted and paged on the server, with
 * the metrics strip on top. Select people to email them one at a time, set a status, tag, export or delete; click a
 * name for the full details. Email opens the owner's own email app; DashPatrol never sends anything. Advanced also
 * shows media requests and paid opportunities.
 */
export function Outreach({ advanced = false }: { advanced?: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [query, setQuery] = useState<Partial<ListQuery>>({ sort: "recent", page: 0 });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [compose, setCompose] = useState<Row[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const { busy, error, act } = useAct(setView);
  const first = useRef(true);
  const load = (q: Partial<ListQuery>, fresh = false) =>
    api<View>(`/api/outreach?${toQueryString(q)}`, undefined, fresh)
      .then(setView)
      .catch(() => undefined);
  useEffect(() => {
    void load(query, !first.current);
    first.current = false;
  }, [query]);
  // The search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => ((q.q ?? "") === search.trim() ? q : { ...q, q: search.trim() || null, page: 0 })), 300);
    return () => clearTimeout(t);
  }, [search]);
  if (!view) return null;
  const set = (patch: Partial<ListQuery>) => {
    setSelected([]);
    setQuery((q) => ({ ...q, ...patch, page: patch.page ?? 0 }));
  };
  const rows = view.journalists;
  const open = rows.find((j) => j.id === openId) ?? null;
  const pages = Math.max(1, Math.ceil(view.total / view.pageSize));
  const allOnPage = rows.length > 0 && rows.every((r) => selected.includes(r.id));
  const filtered = Boolean(query.q || query.status || query.tag || query.field || query.due || query.hasEmail);
  const exportAll = async () => {
    const r = await api<{ rows: Row[] }>("/api/outreach", { action: "export", query });
    saveFile("journalists.csv", journalistsCsv(r.rows));
  };
  // The selected people may be on other pages: their rows are read before the compose panel opens.
  const emailSelected = async (ids: string[]) => {
    const here = rows.filter((r) => ids.includes(r.id));
    const people = here.length === ids.length ? here : (await api<{ rows: Row[] }>("/api/outreach", { action: "export", ids }).catch(() => ({ rows: here }))).rows;
    setOpenId(null);
    setCompose(ids.map((id) => people.find((p) => p.id === id)).filter((p): p is Row => Boolean(p)));
  };
  const filterBy = (f: "due" | "covered") => set(f === "due" ? { due: !query.due } : { status: query.status === "covered" ? null : "covered" });
  const stripFilter = query.due ? "due" : query.status === "covered" ? "covered" : null;
  return (
    <QueryCtx.Provider value={query}>
      <Card className="mt-6">
        <CardHeader title="Journalists" />
        <p className="mb-3 text-xs text-dash-muted">
          People who write about {view.topics.length ? view.topics.join(", ") : "your products"}, and the ones you add or import. Email opens your own email app;
          DashPatrol never sends anything.
        </p>
        <MetricsStrip m={view.metrics} filter={stripFilter} onFilter={filterBy} />

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input aria-label="Search" placeholder="Search name, outlet or email" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded-lg border border-dash-line bg-white px-3 py-1.5 text-sm sm:w-64" />
          <select aria-label="Status" value={query.status ?? ""} onChange={(e) => set({ status: (e.target.value || null) as ListQuery["status"] })} className={select}>
            <option value="">Any status</option>
            {CRM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select aria-label="List" value={query.tag ?? ""} onChange={(e) => set({ tag: e.target.value || null })} className={select}>
            <option value="">Any list</option>
            {view.facets.tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select aria-label="Field" value={query.field ?? ""} onChange={(e) => set({ field: e.target.value || null })} className={select}>
            <option value="">Any field</option>
            {view.facets.fields.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select aria-label="Sort" value={query.sort ?? "recent"} onChange={(e) => set({ sort: e.target.value as ListQuery["sort"] })} className={select}>
            {SORTS.map((o) => (
              <option key={o.id} value={o.id}>
                Sort by {o.label.toLowerCase()}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-dash-ink">
            <input type="checkbox" checked={Boolean(query.due)} onChange={(e) => set({ due: e.target.checked })} /> Follow up today
          </label>
          <label className="flex items-center gap-1 text-xs text-dash-ink">
            <input type="checkbox" checked={Boolean(query.hasEmail)} onChange={(e) => set({ hasEmail: e.target.checked })} /> Has email
          </label>
          <div className="ml-auto flex flex-wrap gap-2">
            <button className={btn} onClick={() => setImporting((v) => !v)}>
              Import CSV
            </button>
            <button className={btn} onClick={() => setAdding((v) => !v)}>
              Add journalist
            </button>
            <button className={btn} disabled={!view.canFindNow || busy !== null} onClick={() => act("find", { action: "find" })} title={view.canFindNow ? "" : "Find more works once a day"}>
              {busy === "find" ? "Looking, this takes a minute" : "Find more now"}
            </button>
            <button className={btn} disabled={!view.total} onClick={exportAll}>
              Download CSV
            </button>
          </div>
        </div>
        {error && <p className="mb-3 text-sm text-dash-down">{error}</p>}
        {adding && <AddJournalist onView={setView} onDone={() => setAdding(false)} />}
        {importing && <ImportCsv onClose={() => setImporting(false)} onDone={() => void load(query, true)} />}

        {selected.length > 0 && <SelectionBar ids={selected} rows={rows} onView={setView} onClear={() => setSelected([])} onEmail={() => void emailSelected(selected)} />}

        {rows.length ? (
          <div className="max-h-[70vh] overflow-auto rounded-xl border border-dash-line">
            <table className="w-full table-fixed text-left text-sm">
              <thead className="sticky top-0 z-10 bg-dash-bg text-xs text-dash-muted">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select this page"
                      checked={allOnPage}
                      onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...rows.map((r) => r.id)])] : selected.filter((id) => !rows.some((r) => r.id === id)))}
                    />
                  </th>
                  <th className="px-2 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium">Outlet</th>
                  <th className="hidden px-2 py-2 font-medium md:table-cell">Email</th>
                  <th className="hidden px-2 py-2 font-medium lg:table-cell">Field</th>
                  <th className="w-32 px-2 py-2 font-medium">Status</th>
                  <th className="hidden w-32 px-2 py-2 font-medium md:table-cell">Last contacted</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => (
                  <tr key={j.id} className={`border-t border-dash-line hover:bg-dash-bg ${selected.includes(j.id) ? "bg-dash-bg" : "bg-white"}`}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${j.name}`}
                        checked={selected.includes(j.id)}
                        onChange={(e) => setSelected(e.target.checked ? [...selected, j.id] : selected.filter((id) => id !== j.id))}
                      />
                    </td>
                    <td className="truncate px-2 py-2">
                      <button className="max-w-full truncate text-left font-semibold text-dash-ink hover:text-dash-green hover:underline" onClick={() => setOpenId(j.id)}>
                        {j.name}
                      </button>
                      {j.due && <span className="ml-1 text-xs text-dash-copper">follow up</span>}
                    </td>
                    <td className="truncate px-2 py-2 text-dash-ink">{j.outlet}</td>
                    <td className="hidden truncate px-2 py-2 text-dash-ink md:table-cell">{j.email ?? <span className="text-dash-muted">None</span>}</td>
                    <td className="hidden truncate px-2 py-2 text-dash-muted lg:table-cell">{j.field ?? ""}</td>
                    <td className="px-2 py-2">
                      <StatusPill s={j.status} />
                    </td>
                    <td className="hidden px-2 py-2 text-xs text-dash-muted md:table-cell">{dayText(j.lastContacted) ?? "Never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-dash-line p-8 text-center">
            {filtered ? (
              <>
                <p className="font-semibold text-dash-ink">Nobody matches these filters.</p>
                <button className={`mt-3 ${btn}`} onClick={() => (setSearch(""), set({ q: null, status: null, tag: null, field: null, due: false, hasEmail: false }))}>
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p className="font-semibold text-dash-ink">No journalists yet</p>
                <p className="mt-1 text-sm text-dash-muted">{view.lastRun.press ?? "The weekly search adds people who write about your products. You can also import your own list."}</p>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <button className={primary} onClick={() => setImporting(true)}>
                    Import CSV
                  </button>
                  <button className={btn} onClick={() => setAdding(true)}>
                    Add journalist
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {view.total > view.pageSize && (
          <div className="mt-3 flex items-center justify-between text-xs text-dash-ink">
            <button className={btn} disabled={view.page === 0} onClick={() => setQuery((q) => ({ ...q, page: view.page - 1 }))}>
              Previous
            </button>
            <span>
              Page {view.page + 1} of {pages} · {view.total.toLocaleString()} people
            </span>
            <button className={btn} disabled={view.page + 1 >= pages} onClick={() => setQuery((q) => ({ ...q, page: view.page + 1 }))}>
              Next
            </button>
          </div>
        )}
      </Card>

      {open && <DetailsDrawer key={open.id} j={open} onView={setView} onEmail={(ids) => void emailSelected(ids)} onClose={() => setOpenId(null)} />}
      {compose && <ComposeDrawer people={compose} templates={view.templates} onView={setView} onClose={() => setCompose(null)} />}

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
    </QueryCtx.Provider>
  );
}
