"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Activity, Contact, ContactOrders, CrmSettings, StockLine, Template } from "@/lib/analytics/crm";
import { guessMapping, IMPORT_FIELDS, mapRows, parseCsv } from "@/lib/analytics/csv";
import { addressName } from "@/lib/analytics/names";
import { goToGoogle } from "./Onboarding";
import { api, apiFresh } from "./seo-ui";
import { Card } from "./ui";

interface GmailState {
  connected: boolean;
  email: string | null;
  sentToday: number;
  cap: number;
}
interface CrmData {
  stages: string[];
  contacts: Contact[];
  tasks: Activity[];
  templates: Template[];
  gmail: GmailState;
  capped?: boolean;
  stock: { onShelf: number; owed: number; dueSoon: number; places: number };
  settings: CrmSettings;
}
type View = "pipeline" | "contacts" | "todo" | "templates";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const shortDate = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const label = (c: Pick<Contact, "name" | "company" | "email">) => c.name || c.company || c.email || "No name";
const closedStage = (s: string) => /^(won|lost)$/i.test(s);
const btn = "rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-60";
const primary = `${btn} bg-dash-green text-white hover:bg-dash-deep`;
const quiet = `${btn} border border-dash-line text-dash-ink hover:bg-black/5`;
const field = "w-full rounded-lg border border-dash-line px-3 py-2 text-sm text-dash-ink";

const KIND_LABEL: Record<Activity["kind"], string> = {
  note: "Note",
  call: "Call",
  meeting: "Meeting",
  email: "Email sent",
  task: "Task",
  stage: "Stage",
  lead: "Website request",
  reply: "They replied",
  stock: "Consignment",
};

/** The owner's CRM: a pipeline board, a contact list, a to do list and email templates, all kept in DashPatrol. */
export function Crm({ active = true }: { active?: boolean }) {
  const [data, setData] = useState<CrmData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("pipeline");
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showStages, setShowStages] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const load = useCallback(() => apiFresh<CrmData>("/api/crm").then((d) => (setData(d), setError(null))).catch((e) => setError(e instanceof Error ? e.message : "The CRM couldn't load.")), []);
  // Fresh each time the page is opened again, so new website requests show without reloading the browser.
  useEffect(() => {
    if (active) load();
  }, [active, load]);
  useEffect(() => {
    const again = () => document.visibilityState === "visible" && active && load();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [active, load]);

  if (!data) return <Card className="mt-2"><p className="text-sm text-dash-muted">{error ?? "Loading your CRM..."}</p></Card>;

  const open_deals = data.contacts.filter((c) => !closedStage(c.stage));
  const wonMonth = data.contacts.filter((c) => /^won$/i.test(c.stage) && (c.stageChangedAt ?? "").slice(0, 7) === today().slice(0, 7));
  const due = dueItems(data);
  const tiles = [
    { label: "Contacts", value: data.contacts.length.toLocaleString() },
    { label: "Open deals", value: money(open_deals.reduce((s, c) => s + c.value, 0)) },
    { label: "To do today", value: String(due.filter((d) => d.date <= today()).length) },
    { label: "Won this month", value: money(wonMonth.reduce((s, c) => s + c.value, 0)) },
    ...(data.stock.places || data.stock.owed > 0
      ? [
          { label: "Items on consignment", value: `${data.stock.onShelf.toLocaleString()} at ${data.stock.places} place${data.stock.places > 1 ? "s" : ""}` },
          { label: "Owed to you, not paid yet", value: `$${data.stock.owed.toFixed(2)}` },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-2xl text-dash-ink">CRM</h2>
            <p className="text-sm text-dash-muted">Your contacts, deals and follow ups in one place. Website requests land here on their own.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={primary} onClick={() => setOpen("new")}>Add contact</button>
            <button className={quiet} onClick={() => setShowImport(true)}>Import</button>
            <button className={quiet} onClick={() => exportCsv(data.contacts)}>Export</button>
            <button className={quiet} onClick={() => setShowStages(true)}>Settings</button>
            <button className={quiet} onClick={() => setShowArchived(true)}>Archived</button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-xl border border-dash-line p-3">
              <p className="text-xs text-dash-muted">{t.label}</p>
              <p className="mt-1 text-xl font-semibold text-dash-ink">{t.value}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-1 border-b border-dash-line">
          {(["pipeline", "contacts", "todo", "templates"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${view === v ? "border-dash-green text-dash-ink" : "border-transparent text-dash-muted hover:text-dash-ink"}`}
            >
              {v === "pipeline" ? "Pipeline" : v === "contacts" ? "Contacts" : v === "todo" ? `To do${due.length ? ` (${due.length})` : ""}` : "Email templates"}
            </button>
          ))}
        </div>
        {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
        {data.capped && <p className="mt-2 text-sm text-dash-muted">Showing your 2,000 most recently updated contacts. Use search to find older ones, or Export.</p>}
        <div className="mt-4">
          {view === "pipeline" && <Pipeline data={data} onOpen={setOpen} onChanged={load} onError={setError} />}
          {view === "contacts" && <ContactList data={data} onOpen={setOpen} />}
          {view === "todo" && <TodoList data={data} items={due} onOpen={setOpen} onChanged={load} onError={setError} />}
          {view === "templates" && <Templates data={data} onChanged={load} onError={setError} />}
        </div>
      </Card>
      {open && <ContactPanel id={open} data={data} onClose={() => setOpen(null)} onChanged={load} onOpenId={setOpen} />}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} onDone={load} />}
      {showArchived && <ArchivedDialog onClose={() => setShowArchived(false)} onDone={load} />}
      {showStages && <StagesDialog stages={data.stages} settings={data.settings} onClose={() => setShowStages(false)} onDone={load} />}
    </div>
  );
}

/** Open tasks and contacts whose follow up date has come, soonest first. */
function dueItems(data: CrmData) {
  const byId = new Map(data.contacts.map((c) => [c.id, c]));
  const items: { key: string; date: string; contact: Contact | undefined; text: string; taskId?: string }[] = [];
  for (const t of data.tasks) items.push({ key: `t${t.id}`, date: t.due ?? "9999-12-31", contact: byId.get(t.contactId), text: t.subject || t.body, taskId: t.id });
  for (const c of data.contacts) if (c.followUp && !closedStage(c.stage)) items.push({ key: `f${c.id}`, date: c.followUp, contact: c, text: "Follow up" });
  // Emails written for the owner come first: one click opens them ready to send.
  for (const c of data.contacts) if (c.draft) items.push({ key: `d${c.id}`, date: "0000-00-00", contact: c, text: `Email ready to send: ${c.draft.subject}` });
  return items.filter((i) => i.contact).sort((a, b) => a.date.localeCompare(b.date));
}

async function post<T = { ok: true; id?: string }>(body: Record<string, unknown>): Promise<T> {
  return api<T>("/api/crm", body);
}

function Pipeline({ data, onOpen, onChanged, onError }: { data: CrmData; onOpen: (id: string) => void; onChanged: () => void; onError: (e: string | null) => void }) {
  const [drag, setDrag] = useState<string | null>(null);
  const move = async (id: string, stage: string) => {
    onError(null);
    try {
      await post({ action: "move", id, stage });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't move it.");
    }
  };
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {data.stages.map((s) => {
        const list = data.contacts.filter((c) => c.stage === s);
        return (
          <div
            key={s}
            className="w-64 shrink-0 rounded-xl bg-black/[0.03] p-2"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = drag ?? e.dataTransfer.getData("text/plain");
              if (id && data.contacts.find((c) => c.id === id)?.stage !== s) move(id, s);
              setDrag(null);
            }}
          >
            <div className="mb-2 flex items-baseline justify-between px-1">
              <p className="text-sm font-semibold text-dash-ink">{s}</p>
              <p className="text-xs text-dash-muted">{list.length} · {money(list.reduce((n, c) => n + c.value, 0))}</p>
            </div>
            <div className="space-y-2">
              {list.map((c) => (
                <div
                  key={c.id}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData("text/plain", c.id); setDrag(c.id); }}
                  onDragEnd={() => setDrag(null)}
                  className="cursor-pointer rounded-lg border border-dash-line bg-white p-2 text-sm shadow-sm hover:border-dash-green"
                  onClick={() => onOpen(c.id)}
                >
                  <p className="font-semibold text-dash-ink break-words [overflow-wrap:anywhere]">{label(c)}</p>
                  {c.name && c.company && <p className="text-xs text-dash-muted break-words">{c.company}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-dash-muted">
                    {c.value > 0 && <span className="font-semibold text-dash-ink">{money(c.value)}</span>}
                    {c.followUp && <span className={c.followUp <= today() ? "font-semibold text-dash-down" : ""}>Follow up {shortDate(c.followUp)}</span>}
                    {c.openTasks > 0 && <span>{c.openTasks} task{c.openTasks > 1 ? "s" : ""}</span>}
                  </div>
                  <select
                    aria-label="Move to stage"
                    className="mt-2 w-full rounded border border-dash-line px-1 py-0.5 text-xs text-dash-ink"
                    value={c.stage}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => move(c.id, e.target.value)}
                  >
                    {data.stages.map((x) => <option key={x}>{x}</option>)}
                  </select>
                </div>
              ))}
              {!list.length && <p className="px-1 py-3 text-xs text-dash-muted">Nobody here yet.</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ContactList({ data, onOpen }: { data: CrmData; onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [tag, setTag] = useState("");
  const tags = useMemo(() => [...new Set(data.contacts.flatMap((c) => c.tags))].sort(), [data.contacts]);
  const list = data.contacts.filter((c) => {
    const text = `${c.name} ${c.company} ${c.email} ${c.phone} ${c.tags.join(" ")} ${c.kind}`.toLowerCase();
    return (!q || text.includes(q.toLowerCase())) && (!stage || c.stage === stage) && (!tag || c.tags.includes(tag));
  });
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <input className={`${field} max-w-xs`} placeholder="Search name, company, email or tag" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${field} w-auto`} value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">All stages</option>
          {data.stages.map((s) => <option key={s}>{s}</option>)}
        </select>
        {tags.length > 0 && (
          <select className={`${field} w-auto`} value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All tags</option>
            {tags.map((t) => <option key={t}>{t}</option>)}
          </select>
        )}
      </div>
      {!data.contacts.length ? (
        <p className="text-sm text-dash-muted">No contacts yet. Click Add contact, or Import a spreadsheet. Requests from your website forms are added here on their own.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-dash-muted">
              <tr><th className="py-2">Name</th><th>Company</th><th>Stage</th><th>Value</th><th>Last contact</th><th>Follow up</th></tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="cursor-pointer border-t border-dash-line hover:bg-black/[0.03]" onClick={() => onOpen(c.id)}>
                  <td className="py-2 pr-2">
                    <p className="font-semibold text-dash-ink">{c.name || c.email || "No name"}</p>
                    <p className="text-xs text-dash-muted">{c.email}</p>
                  </td>
                  <td className="pr-2 text-dash-ink">{c.company}</td>
                  <td className="pr-2 text-dash-ink">{c.stage}</td>
                  <td className="pr-2 text-dash-ink">{c.value ? money(c.value) : ""}</td>
                  <td className="pr-2 text-dash-muted">{c.lastContactAt ? shortDate(c.lastContactAt) : "Never"}</td>
                  <td className={`pr-2 ${c.followUp && c.followUp <= today() ? "font-semibold text-dash-down" : "text-dash-muted"}`}>{c.followUp ? shortDate(c.followUp) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <p className="mt-2 text-sm text-dash-muted">No contact matches that search.</p>}
        </div>
      )}
    </div>
  );
}

function TodoList({ data, items, onOpen, onChanged, onError }: {
  data: CrmData;
  items: ReturnType<typeof dueItems>;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onError: (e: string | null) => void;
}) {
  const [writing, setWriting] = useState<string | null>(null);
  const writeNow = async () => {
    setWriting("Writing emails, this takes about a minute...");
    try {
      const out = await post<{ written: number; failed: string[] }>({ action: "draftAll" });
      setWriting(out.written ? `${out.written} email${out.written > 1 ? "s" : ""} written. They are at the top of this list.` : out.failed[0] ?? "No emails are due: every new contact with an email already has one.");
      onChanged();
    } catch (e) {
      setWriting(e instanceof Error ? e.message : "Couldn't write them.");
    }
  };
  const writeBar = data.settings.autoDraft ? (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-dash-muted">
      <span>Emails are written for new contacts and follow ups every hour, ready for you to send.</span>
      <button className={quiet} disabled={writing === "Writing emails, this takes about a minute..."} onClick={writeNow}>Write them now</button>
      {writing && <span className="text-dash-ink">{writing}</span>}
    </div>
  ) : null;
  if (!items.length) return <div>{writeBar}<p className="text-sm text-dash-muted">Nothing to do. Add a task or a follow up date on a contact and it shows here.</p></div>;
  const done = async (taskId: string) => {
    try {
      await post({ action: "task", taskId, done: true });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't mark it done.");
    }
  };
  return (
    <div>
    {writeBar}
    <ul className="space-y-2">
      {items.map((i) => {
        const late = i.date < today();
        const now = i.date === today();
        return (
          <li key={i.key} className="flex flex-wrap items-center gap-3 rounded-xl border border-dash-line p-3 text-sm">
            {i.taskId ? (
              <input type="checkbox" aria-label="Done" className="h-4 w-4" checked={false} onChange={() => done(i.taskId!)} />
            ) : (
              <span className="h-4 w-4" />
            )}
            <button className="min-w-0 flex-1 text-left" onClick={() => i.contact && onOpen(i.contact.id)}>
              <p className="font-semibold text-dash-ink break-words [overflow-wrap:anywhere]">{i.text}</p>
              <p className="text-xs text-dash-muted">{i.contact ? label(i.contact) : ""}{i.contact?.company && i.contact.name ? `, ${i.contact.company}` : ""}</p>
            </button>
            <span className={`text-xs font-semibold ${i.date === "0000-00-00" ? "text-dash-green" : late ? "text-dash-down" : now ? "text-dash-green" : "text-dash-muted"}`}>
              {i.date === "0000-00-00" ? "Review and send" : i.date === "9999-12-31" ? "No date" : late ? `Late, ${shortDate(i.date)}` : now ? "Today" : shortDate(i.date)}
            </span>
          </li>
        );
      })}
    </ul>
    </div>
  );
}

function Templates({ data, onChanged, onError }: { data: CrmData; onChanged: () => void; onError: (e: string | null) => void }) {
  const [edit, setEdit] = useState<Partial<Template> | null>(null);
  const save = async () => {
    try {
      await post({ action: "template", template: edit });
      setEdit(null);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't save the template.");
    }
  };
  return (
    <div>
      <p className="mb-3 text-sm text-dash-muted">
        Write an email once and reuse it. In the subject or message, {"{first_name}"} (like Ana, or Dr. Hamer for a doctor), {"{name}"} and {"{company}"} are filled in for each contact.
      </p>
      <ul className="space-y-2">
        {data.templates.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dash-line p-3 text-sm">
            <div className="min-w-0">
              <p className="font-semibold text-dash-ink">{t.name}</p>
              <p className="text-xs text-dash-muted break-words">{t.subject}</p>
            </div>
            <div className="flex gap-2">
              <button className={quiet} onClick={() => setEdit(t)}>Edit</button>
              <button
                className={quiet}
                onClick={async () => {
                  if (!window.confirm(`Delete the template ${t.name}?`)) return;
                  try {
                    await post({ action: "deleteTemplate", templateId: t.id });
                    onChanged();
                  } catch (e) {
                    onError(e instanceof Error ? e.message : "Couldn't delete it.");
                  }
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!edit && <button className={`${primary} mt-3`} onClick={() => setEdit({ name: "", subject: "", body: "" })}>New template</button>}
      {edit && (
        <div className="mt-3 space-y-2 rounded-xl border border-dash-line p-3">
          <input className={field} placeholder="Template name, like Clinic intro" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <input className={field} placeholder="Subject" value={edit.subject ?? ""} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
          <textarea className={`${field} min-h-[160px]`} placeholder="Hi {first_name}," value={edit.body ?? ""} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
          <div className="flex gap-2">
            <button className={primary} onClick={save}>Save template</button>
            <button className={quiet} onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const EMPTY: Partial<Contact> = { name: "", email: "", phone: "", company: "", title: "", kind: "", stage: "", value: 0, tags: [], address: "", website: "", followUp: null };

function ContactPanel({ id, data, onClose, onChanged, onOpenId }: { id: string; data: CrmData; onClose: () => void; onChanged: () => void; onOpenId: (id: string) => void }) {
  const [contact, setContact] = useState<Partial<Contact>>(id === "new" ? { ...EMPTY, stage: data.stages[0] } : {});
  const [acts, setActs] = useState<Activity[]>([]);
  const [editing, setEditing] = useState(id === "new");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "note" | "call" | "meeting" | "reply" | "task"; subject: string; body: string; due: string } | null>(null);
  const [stock, setStock] = useState<StockLine[]>([]);
  const [orders, setOrders] = useState<ContactOrders | "access" | "failed" | null>(null);
  const [mail, setMail] = useState(false);
  // Tags are typed as one line and split on commas when saved, so typing never jumps or adds spaces.
  const [tagText, setTagText] = useState("");
  const loadOne = useCallback(async () => {
    if (id === "new") return;
    const t = await apiFresh<{ contact: Contact; activities: Activity[]; stock: StockLine[]; orders: ContactOrders | "access" | "failed" | null }>(`/api/crm?contact=${id}`);
    setContact(t.contact);
    setTagText(t.contact.tags.join(", "));
    setActs(t.activities);
    setStock(t.stock ?? []);
    setOrders(t.orders ?? null);
  }, [id]);
  useEffect(() => {
    loadOne().catch((e) => setErr(e instanceof Error ? e.message : "Couldn't open the contact."));
  }, [loadOne]);

  const run = async (body: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    setErr(null);
    try {
      const out = await post(body);
      after?.();
      onChanged();
      if (id === "new" && out.id) onOpenId(out.id);
      else await loadOne();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't work. Try again.");
    }
    setBusy(false);
  };
  const c = contact;
  const set = (k: keyof Contact, v: unknown) => setContact({ ...contact, [k]: v });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-serif text-xl text-dash-ink break-words">{id === "new" ? "New contact" : label(c as Contact)}</h3>
            {id !== "new" && <p className="text-sm text-dash-muted">{[c.company, c.stage, c.value ? money(c.value) : ""].filter(Boolean).join(" · ")}</p>}
          </div>
          <button className={quiet} onClick={onClose}>Close</button>
        </div>
        {err && <p className="mt-2 text-sm text-dash-down">{err}</p>}

        {id !== "new" && !editing && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button className={primary} onClick={() => setMail(true)}>Email</button>
            <button className={quiet} onClick={() => setNote({ kind: "call", subject: "", body: "", due: "" })}>Log call</button>
            <button className={quiet} onClick={() => setNote({ kind: "meeting", subject: "", body: "", due: "" })}>Log meeting</button>
            <button className={quiet} onClick={() => setNote({ kind: "note", subject: "", body: "", due: "" })}>Add note</button>
            <button className={quiet} onClick={() => setNote({ kind: "task", subject: "", body: "", due: today() })}>Add task</button>
            <button className={quiet} onClick={() => setNote({ kind: "reply", subject: "", body: "", due: "" })}>They replied</button>
            <button className={quiet} onClick={() => setEditing(true)}>Edit</button>
            {c.phone && <a className={quiet} href={`tel:${c.phone}`}>Call {c.phone}</a>}
          </div>
        )}

        {(editing || id === "new") && (
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input label="Name" v={c.name} on={(v) => set("name", v)} />
            <Input label="Company" v={c.company} on={(v) => set("company", v)} />
            <Input label="Email" v={c.email} on={(v) => set("email", v)} type="email" />
            <Input label="Phone" v={c.phone} on={(v) => set("phone", v)} type="tel" />
            <Input label="Job title" v={c.title} on={(v) => set("title", v)} />
            <Input label="Type, like Clinic or Store" v={c.kind} on={(v) => set("kind", v)} />
            <label className="text-xs text-dash-muted">Stage
              <select className={field} value={c.stage} onChange={(e) => set("stage", e.target.value)}>{data.stages.map((s) => <option key={s}>{s}</option>)}</select>
            </label>
            <Input label="Deal value in dollars" v={c.value ? String(c.value) : ""} on={(v) => set("value", v)} />
            <Input label="Follow up on" v={c.followUp ?? ""} on={(v) => set("followUp", v || null)} type="date" />
            <Input label="Tags, separated by commas" v={tagText} on={setTagText} />
            <Input label="Website" v={c.website} on={(v) => set("website", v)} />
            <Input label="Address" v={c.address} on={(v) => set("address", v)} />
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <button disabled={busy} className={primary} onClick={() => run({ action: "save", id: id === "new" ? undefined : id, contact: { ...c, tags: tagText } }, () => setEditing(false))}>Save</button>
              {id !== "new" && <button className={quiet} onClick={() => { setEditing(false); loadOne(); }}>Cancel</button>}
              {id !== "new" && (
                <button className={`${quiet} text-dash-down`} onClick={() => run({ action: "archive", id }, onClose)}>Archive contact</button>
              )}
            </div>
          </div>
        )}

        {id !== "new" && !editing && (
          <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            {([
              ["Email", c.email],
              ["Phone", c.phone],
              ["Job title", c.title],
              ["Type", c.kind],
              ["Follow up", c.followUp ? shortDate(c.followUp) : ""],
              ["Tags", (c.tags ?? []).join(", ")],
              ["Website", c.website],
              ["Address", c.address],
              ["Came from", c.source],
            ] as [string, string | undefined][]).filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="min-w-0"><dt className="text-xs text-dash-muted">{k}</dt><dd className="text-dash-ink break-words [overflow-wrap:anywhere]">{v}</dd></div>
            ))}
          </dl>
        )}

        {note && (
          <div className="mt-4 space-y-2 rounded-xl border border-dash-line p-3">
            <p className="text-sm font-semibold text-dash-ink">{KIND_LABEL[note.kind]}</p>
            <input className={field} placeholder={note.kind === "task" ? "What needs doing, like Send samples" : note.kind === "reply" ? "What they said, in a few words (optional)" : "Short title (optional)"} value={note.subject} onChange={(e) => setNote({ ...note, subject: e.target.value })} />
            {note.kind !== "task" && <textarea className={`${field} min-h-[100px]`} placeholder="What was said or decided" value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} />}
            {note.kind === "task" && <input type="date" className={field} value={note.due} onChange={(e) => setNote({ ...note, due: e.target.value })} />}
            <div className="flex gap-2">
              <button disabled={busy} className={primary} onClick={() => run({ action: "activity", id, activity: note }, () => setNote(null))}>Save</button>
              <button className={quiet} onClick={() => setNote(null)}>Cancel</button>
            </div>
          </div>
        )}

        {id !== "new" && !editing && <Orders orders={orders} />}
        {id !== "new" && !editing && <Consignment contactId={id} lines={stock} busy={busy} run={run} />}

        {id !== "new" && !editing && !mail && c.draft && (
          <div className="mt-4 rounded-xl border border-dash-green bg-dash-green/5 p-3 text-sm">
            <p className="font-semibold text-dash-ink">{c.draft.kind === "followup" ? "A follow up is written and ready" : "An email is written and ready"}</p>
            <p className="mt-1 text-dash-ink break-words">{c.draft.subject}</p>
            <p className="mt-1 text-xs text-dash-muted">
              {c.draft.checked === "ai" ? "Checked by a second AI. Read it before you send." : "No second AI was free to check it. Read it carefully before you send."}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className={primary} onClick={() => setMail(true)}>Review and send</button>
              <button className={quiet} disabled={busy} onClick={() => run({ action: "discardDraft", id })}>Throw it away</button>
            </div>
          </div>
        )}
        {id !== "new" && !editing && !mail && !c.draft && c.email && (
          <button className={`${quiet} mt-4`} disabled={busy} onClick={() => run({ action: "draft", id, kind: acts.some((a) => a.kind === "email") ? "followup" : "intro", lastSubject: acts.find((a) => a.kind === "email")?.subject ?? null })}>
            {busy ? "Writing..." : "Write an email for me"}
          </button>
        )}
        {mail && <EmailComposer contact={c as Contact} data={data} onClose={() => setMail(false)} onSent={() => { setMail(false); onChanged(); loadOne(); }} />}

        {id !== "new" && (
          <div className="mt-6">
            <h4 className="mb-2 text-sm font-semibold text-dash-ink">History</h4>
            {!acts.length && <p className="text-sm text-dash-muted">Nothing yet. Emails, calls, notes and tasks show here.</p>}
            <ul className="space-y-2">
              {acts.map((a) => (
                <li key={a.id} className="rounded-xl border border-dash-line p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-dash-ink">
                      {a.kind === "task" && (
                        <input type="checkbox" className="mr-2 align-middle" checked={a.done} onChange={() => run({ action: "task", taskId: a.id, done: !a.done })} />
                      )}
                      {KIND_LABEL[a.kind]}{a.subject ? `: ${a.subject}` : ""}
                    </p>
                    <p className="text-xs text-dash-muted">
                      {a.kind === "task" && a.due ? `Due ${shortDate(a.due)} · ` : ""}{shortDate(a.at)}
                      {["note", "call", "meeting", "task"].includes(a.kind) && (
                        <button className="ml-2 text-dash-muted hover:text-dash-down" onClick={() => run({ action: "deleteActivity", activityId: a.id })}>Delete</button>
                      )}
                    </p>
                  </div>
                  {a.body && <p className="mt-1 whitespace-pre-wrap text-dash-ink break-words [overflow-wrap:anywhere]">{a.body}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Input({ label: l, v, on, type = "text" }: { label: string; v: string | undefined; on: (v: string) => void; type?: string }) {
  return (
    <label className="text-xs text-dash-muted">
      {l}
      <input className={field} type={type} value={v ?? ""} onChange={(e) => on(e.target.value)} />
    </label>
  );
}

function EmailComposer({ contact, data, onClose, onSent }: { contact: Contact; data: CrmData; onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState(contact.email);
  const [subject, setSubject] = useState(contact.draft?.subject ?? "");
  const [body, setBody] = useState(contact.draft?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const fill = (t: string) => t
    .replace(/\{first_name\}/gi, addressName(contact.name) || "there")
    .replace(/\{name\}/gi, contact.name || "there")
    .replace(/\{company\}/gi, contact.company || "your business");
  const pick = (tid: string) => {
    const t = data.templates.find((x) => x.id === tid);
    if (t) {
      setSubject(fill(t.subject));
      setBody(fill(t.body));
    }
  };
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post({ action: "email", id: contact.id, email: { to, subject, body } });
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "It didn't send.");
    }
    setBusy(false);
  };
  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <div className="mt-4 space-y-2 rounded-xl border border-dash-line p-3">
      <p className="text-sm font-semibold text-dash-ink">Email {label(contact)}</p>
      {data.templates.length > 0 && (
        <select className={field} defaultValue="" onChange={(e) => pick(e.target.value)}>
          <option value="">Start from a template</option>
          {data.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      <input className={field} placeholder="To" value={to} onChange={(e) => setTo(e.target.value)} />
      <input className={field} placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <textarea className={`${field} min-h-[180px]`} placeholder="Your message" value={body} onChange={(e) => setBody(e.target.value)} />
      {err && <p className="text-sm text-dash-down">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {data.gmail.connected ? (
          <button disabled={busy || !to || !subject || !body} className={primary} onClick={send}>Send from {data.gmail.email}</button>
        ) : (
          <button className={primary} onClick={() => goToGoogle("gmail").catch((e) => setErr(e instanceof Error ? e.message : "Couldn't open Google."))}>Allow sending from Gmail</button>
        )}
        <a className={quiet} href={mailto} onClick={() => setOpened(true)}>Open in my email</a>
        {opened && (
          <button
            className={quiet}
            disabled={busy}
            onClick={async () => {
              try {
                await post({ action: "logEmail", id: contact.id, email: { subject, body } });
                onSent();
              } catch (e) {
                setErr(e instanceof Error ? e.message : "Couldn't save it.");
              }
            }}
          >
            I sent it, save it here
          </button>
        )}
        <button className={quiet} onClick={onClose}>Cancel</button>
      </div>
      {data.gmail.connected && <p className="text-xs text-dash-muted">{data.gmail.sentToday} of {data.gmail.cap} emails sent from the app today. Each one is sent only when you click Send.</p>}
    </div>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [table, setTable] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const read = async (f: File) => {
    setMsg(null);
    const t = parseCsv(await f.text());
    if (t.length < 2) {
      setTable(null);
      return setMsg("That file has no rows to import. Save your spreadsheet as CSV with a header row first.");
    }
    setTable(t);
    // A column the importer doesn't recognise goes to Notes, so nothing in the file is lost.
    setMapping(guessMapping(t[0]).map((m) => m || "note"));
  };
  const rows = table ? mapRows(table, mapping) : [];
  const used = (key: string, i: number) => key && key !== "note" && mapping.some((m, j) => m === key && j !== i);
  const go = async () => {
    if (!rows.length) return;
    setBusy(true);
    const total = { added: 0, updated: 0, skipped: 0 };
    const list = rows.slice(0, 1000);
    try {
      // In batches of 100, so a big file never runs into a time limit; a stop part way keeps what was already added.
      for (let i = 0; i < list.length; i += 100) {
        setMsg(`Importing ${Math.min(i + 100, list.length).toLocaleString()} of ${list.length.toLocaleString()}...`);
        const out = await post<{ result: { added: number; updated: number; skipped: number } }>({ action: "import", rows: list.slice(i, i + 100) });
        total.added += out.result.added;
        total.updated += out.result.updated;
        total.skipped += out.result.skipped;
      }
      setMsg(`Added ${total.added}, filled in ${total.updated} that were already here, skipped ${total.skipped} without a name, company, phone or valid email.`);
      setTable(null);
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : "The import stopped."} ${total.added} were added before it stopped.`);
    }
    onDone();
    setBusy(false);
  };
  const first = rows[0];
  return (
    <Dialog title="Import contacts" onClose={onClose}>
      <p className="text-sm text-dash-muted">
        Pick a CSV file, saved from Excel, Google Sheets or another CRM. Any layout works: you see each column and where it goes, and can change it. A contact who is already here only gets their empty fields filled in.
      </p>
      <input type="file" accept=".csv,text/csv" className="mt-3 text-sm" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
      {table && (
        <div className="mt-3">
          <p className="mb-2 text-sm font-semibold text-dash-ink">Where each column goes</p>
          <ul className="space-y-1">
            {table[0].map((h, i) => (
              <li key={i} className="grid grid-cols-2 items-center gap-2 text-sm">
                <span className="min-w-0 break-words text-dash-ink">
                  {h.trim() || `Column ${i + 1}`}
                  <span className="block truncate text-xs text-dash-muted">{table[1]?.[i] ?? ""}</span>
                </span>
                <select
                  className={`${field} py-1`}
                  value={mapping[i] ?? ""}
                  onChange={(e) => setMapping(mapping.map((m, j) => (j === i ? e.target.value : m)))}
                >
                  <option value="">Skip this column</option>
                  <option value="note">Add to notes</option>
                  {IMPORT_FIELDS.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}{used(f.key, i) ? " (also used by another column)" : ""}</option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-dash-ink">
            {rows.length.toLocaleString()} rows{rows.length > 1000 ? "; the first 1,000 are imported" : ""}.
            {first ? ` First one: ${[first.name, first.company, first.email, first.phone].filter(Boolean).join(", ") || "nothing to add, check the columns above"}.` : ""}
          </p>
          <button disabled={busy || !rows.length} className={`${primary} mt-2`} onClick={go}>{busy ? "Importing..." : "Import"}</button>
        </div>
      )}
      {msg && <p className="mt-3 text-sm text-dash-ink">{msg}</p>}
    </Dialog>
  );
}

function ArchivedDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [list, setList] = useState<Contact[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const read = useCallback(() => apiFresh<{ contacts: Contact[] }>("/api/crm?archived=1").then((d) => setList(d.contacts)).catch((e) => setErr(e instanceof Error ? e.message : "Couldn't load them.")), []);
  useEffect(() => {
    read();
  }, [read]);
  const restore = async (id: string) => {
    try {
      await post({ action: "restore", id });
      await read();
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't restore it.");
    }
  };
  return (
    <Dialog title="Archived contacts" onClose={onClose}>
      <p className="text-sm text-dash-muted">Archived contacts keep their whole history. Restore puts one back on your lists.</p>
      {err && <p className="mt-2 text-sm text-dash-down">{err}</p>}
      {list && !list.length && <p className="mt-3 text-sm text-dash-muted">Nothing is archived.</p>}
      <ul className="mt-3 space-y-2">
        {(list ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 rounded-xl border border-dash-line p-2 text-sm">
            <span className="min-w-0 break-words text-dash-ink">{label(c)}{c.company && c.name ? `, ${c.company}` : ""}</span>
            <button className={quiet} onClick={() => restore(c.id)}>Restore</button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function StagesDialog({ stages, settings, onClose, onDone }: { stages: string[]; settings: CrmSettings; onClose: () => void; onDone: () => void }) {
  const [list, setList] = useState(stages.join("\n"));
  const [days, setDays] = useState(String(settings.followUpDays));
  const [daily, setDaily] = useState(settings.dailyEmail);
  const [auto, setAuto] = useState(settings.autoDraft);
  const [offer, setOffer] = useState(settings.offer);
  const [link, setLink] = useState(settings.link);
  const [signoff, setSignoff] = useState(settings.signoff);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!/^\d+$/.test(days.trim())) return setErr("Put a number of days for follow ups, 0 to turn them off.");
    try {
      await post({ action: "settings", settings: { followUpDays: Number(days), dailyEmail: daily, autoDraft: auto, offer, link, signoff } });
      await post({ action: "stages", stages: list.split("\n") });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save the settings.");
    }
  };
  return (
    <Dialog title="CRM settings" onClose={onClose}>
      <p className="text-sm font-semibold text-dash-ink">Pipeline stages</p>
      <p className="text-sm text-dash-muted">
        One stage per line, in order. Rename a stage in its place and its contacts stay with it. Contacts in a stage you take out move to the first stage. Stages named Won or Lost count as closed deals.
      </p>
      <textarea className={`${field} mt-2 min-h-[160px]`} value={list} onChange={(e) => setList(e.target.value)} />
      <p className="mt-4 text-sm font-semibold text-dash-ink">Follow ups</p>
      <label className="mt-1 block text-sm text-dash-ink">
        Add a follow up task when nothing is logged from a contact this many days after you email them (0 turns it off)
        <input type="number" min={0} max={60} className={`${field} mt-1 w-24`} value={days} onChange={(e) => setDays(e.target.value)} />
      </label>
      <p className="mt-1 text-xs text-dash-muted">Click They replied on a contact when they answer, so no follow up is added.</p>
      <label className="mt-3 flex items-center gap-2 text-sm text-dash-ink">
        <input type="checkbox" checked={daily} onChange={(e) => setDaily(e.target.checked)} />
        Email me each morning with what is due today and late
      </label>
      <p className="mt-4 text-sm font-semibold text-dash-ink">Emails written for you</p>
      <label className="mt-1 flex items-center gap-2 text-sm text-dash-ink">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        Write a first email for each new contact with an email, and a follow up when they don&apos;t reply. You read each one and click Send.
      </label>
      <label className="mt-2 block text-sm text-dash-ink">
        What you offer, in your own words. It goes into every first email exactly as you write it.
        <textarea className={`${field} mt-1 min-h-[110px]`} value={offer} onChange={(e) => setOffer(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-dash-ink">
        A page to point to (optional)
        <input className={`${field} mt-1`} placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-dash-ink">
        Sign off with
        <input className={`${field} mt-1`} placeholder="Your name, your business" value={signoff} onChange={(e) => setSignoff(e.target.value)} />
      </label>
      {err && <p className="mt-2 text-sm text-dash-down">{err}</p>}
      <button className={`${primary} mt-3`} onClick={save}>Save settings</button>
    </Dialog>
  );
}

function Orders({ orders }: { orders: ContactOrders | "access" | "failed" | null }) {
  if (!orders) return null;
  if (orders === "access" || orders === "failed")
    return (
      <p className="mt-4 text-xs text-dash-muted">
        {orders === "access" ? "Store orders can't be read yet: reconnect Shopify from Connections and allow orders." : "Store orders couldn't be read just now. Open the contact again later."}
      </p>
    );
  return (
    <div className="mt-4 rounded-xl border border-dash-line p-3">
      <p className="text-sm font-semibold text-dash-ink">In your store, last 60 days</p>
      {!orders.count ? (
        <p className="text-sm text-dash-muted">No paid orders with this email in the last 60 days.</p>
      ) : (
        <>
          <p className="text-sm text-dash-ink">
            {orders.count}
            {orders.more ? "+" : ""} paid order{orders.count > 1 ? "s" : ""}, {orders.currency === "USD" ? "$" : `${orders.currency} `}
            {orders.total.toFixed(2)} in total{orders.more ? " for the latest 50" : ""}. Last one {shortDate(orders.last!)}.
          </p>
          <ul className="mt-1 text-xs text-dash-muted">
            {orders.recent.map((o) => (
              <li key={o.name}>{o.name}, {shortDate(o.at)}, {orders.currency === "USD" ? "$" : `${orders.currency} `}{o.total.toFixed(2)}{o.status ? `, ${o.status}` : ""}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Consignment({ contactId, lines, busy, run }: {
  contactId: string;
  lines: StockLine[];
  busy: boolean;
  run: (body: Record<string, unknown>, after?: () => void) => Promise<void>;
}) {
  const [adding, setAdding] = useState<{ product: string; qty: string; price: string; everyDays: string } | null>(null);
  const [counting, setCounting] = useState<{ stockId: string; counted: string; restock: string } | null>(null);
  return (
    <div className="mt-4 rounded-xl border border-dash-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-dash-ink">Consignment</p>
        {!adding && <button className={quiet} onClick={() => setAdding({ product: "", qty: "12", price: "", everyDays: "30" })}>Leave stock</button>}
      </div>
      {!lines.length && !adding && <p className="text-sm text-dash-muted">No stock left here. Click Leave stock when you leave items with them, and the CRM reminds you when to count.</p>}
      {adding && (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input label="Product" v={adding.product} on={(v) => setAdding({ ...adding, product: v })} />
          <Input label="How many left" v={adding.qty} on={(v) => setAdding({ ...adding, qty: v })} type="number" />
          <Input label="You get per item sold, in dollars" v={adding.price} on={(v) => setAdding({ ...adding, price: v })} />
          <Input label="Count every how many days" v={adding.everyDays} on={(v) => setAdding({ ...adding, everyDays: v })} type="number" />
          <div className="flex gap-2 sm:col-span-2">
            <button disabled={busy} className={primary} onClick={() => run({ action: "stock", id: contactId, stock: adding }, () => setAdding(null))}>Save</button>
            <button className={quiet} onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </div>
      )}
      <ul className="mt-2 space-y-3">
        {lines.map((l) => {
          const unpaid = l.counts.filter((c) => !c.paid && c.owed > 0);
          return (
            <li key={l.id} className={`text-sm ${l.closed ? "opacity-60" : ""}`}>
              <p className="font-semibold text-dash-ink break-words">{l.product}</p>
              <p className="text-dash-ink">
                {l.closed ? "Ended. " : `${l.onShelf} on the shelf. `}${l.price.toFixed(2)} per item sold.
                {!l.closed && l.nextCount ? ` Next count ${shortDate(l.nextCount)}.` : ""}
                {unpaid.length ? ` $${unpaid.reduce((s, c) => s + c.owed, 0).toFixed(2)} not paid yet.` : ""}
              </p>
              {!l.closed && counting?.stockId !== l.id && (
                <div className="mt-1 flex flex-wrap gap-2">
                  <button className={quiet} onClick={() => setCounting({ stockId: l.id, counted: "", restock: "" })}>Count</button>
                  <button className={quiet} onClick={() => window.confirm(`End the consignment of ${l.product}? Its history stays.`) && run({ action: "closeStock", stockId: l.id })}>End</button>
                </div>
              )}
              {counting?.stockId === l.id && (
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input label={`Still on the shelf (was ${l.onShelf})`} v={counting.counted} on={(v) => setCounting({ ...counting, counted: v })} type="number" />
                  <Input label="Items you added now" v={counting.restock} on={(v) => setCounting({ ...counting, restock: v })} type="number" />
                  {counting.counted !== "" && Number(counting.counted) <= l.onShelf && (
                    <p className="text-sm text-dash-ink sm:col-span-2">
                      {l.onShelf - Number(counting.counted)} sold, ${((l.onShelf - Number(counting.counted)) * l.price).toFixed(2)} owed to you.
                    </p>
                  )}
                  <div className="flex gap-2 sm:col-span-2">
                    <button disabled={busy || counting.counted === ""} className={primary} onClick={() => run({ action: "count", stockId: l.id, count: { counted: counting.counted, restock: counting.restock || 0 } }, () => setCounting(null))}>Save count</button>
                    <button className={quiet} onClick={() => setCounting(null)}>Cancel</button>
                  </div>
                </div>
              )}
              {l.counts.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-dash-muted">
                  {l.counts.slice(0, 6).map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      <span>{shortDate(c.countedAt)}: {c.sold} sold, ${c.owed.toFixed(2)}{c.restocked ? `, ${c.restocked} added` : ""}</span>
                      {c.owed > 0 && (
                        <label className="flex items-center gap-1 text-dash-ink">
                          <input type="checkbox" disabled={busy} checked={c.paid} onChange={() => run({ action: "paid", countId: c.id, paid: !c.paid })} />
                          Paid
                        </label>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-serif text-xl text-dash-ink">{title}</h3>
          <button className={quiet} onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Downloads every contact as a CSV file the owner can open in Excel or Google Sheets. */
function exportCsv(contacts: Contact[]) {
  const head = ["Name", "Email", "Phone", "Company", "Title", "Type", "Stage", "Value", "Tags", "Follow up", "Last contact", "Website", "Address", "Came from", "Added"];
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  // A cell starting with = + @ or a minus sign would run as a formula in a spreadsheet; a leading apostrophe stops it.
  const safe = (v: string) => esc(/^[=+@\-\t\r]/.test(v) ? `'${v}` : v);
  const lines = [head.join(",")].concat(
    contacts.map((c) =>
      [c.name, c.email, c.phone, c.company, c.title, c.kind, c.stage, c.value ? String(c.value) : "", c.tags.join("; "), c.followUp ?? "", c.lastContactAt?.slice(0, 10) ?? "", c.website, c.address, c.source, c.createdAt.slice(0, 10)]
        .map(safe)
        .join(","),
    ),
  );
  // The byte order mark lets Excel read names with accents correctly.
  const url = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `contacts-${today()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
