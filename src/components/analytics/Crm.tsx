"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Activity, Contact, ContactFile, ContactOrders, CrmSettings, StockLine, Template } from "@/lib/analytics/crm";
import { guessMapping, IMPORT_FIELDS, mapRows, parseCsv } from "@/lib/analytics/csv";
import { addressName, plainCompany } from "@/lib/analytics/names";
import { matchProducts, productsFromLines, productsToLines } from "@/lib/analytics/pitch";
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
  /** The segment the board and counts are for; "" for everyone. */
  segment: string;
  /** Each stage's newest cards, plus the contacts behind tasks and waiting emails. */
  contacts: Contact[];
  stageCounts: Record<string, { n: number; value: number }>;
  segmentCounts: Record<string, number>;
  totals: { contacts: number; openValue: number; wonMonth: number };
  tasks: Activity[];
  templates: Template[];
  gmail: GmailState;
  stock: { onShelf: number; owed: number; dueSoon: number; places: number };
  settings: CrmSettings;
}
/** Cards per stage page, as the owner picks them (remembered on this browser). */
const CARD_SIZES = [10, 30, 50, 100];
const readCards = () => {
  try {
    const n = Number(localStorage.getItem("crm_cards"));
    return CARD_SIZES.includes(n) ? n : 10;
  } catch {
    return 10;
  }
};
/** The products that fit a contact, from the owner's product list. */
const pitchFor = (data: CrmData, c: Contact, max = 2) => matchProducts(`${c.kind} ${c.segment} ${c.company}`, data.settings.products ?? [], max);
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
  file: "File",
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
  const [segment, setSegment] = useState("");
  const [listStage, setListStage] = useState("");
  const [segMsg, setSegMsg] = useState<string | null>(null);
  const [cards, setCards] = useState(10);
  useEffect(() => setCards(readCards()), []);
  const load = useCallback(
    () =>
      apiFresh<CrmData>(`/api/crm?${new URLSearchParams({ segment, cards: String(cards) })}`)
        .then((d) => (setData(d), setError(null)))
        .catch((e) => setError(e instanceof Error ? e.message : "The CRM couldn't load.")),
    [segment, cards],
  );
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

  const due = dueItems(data);
  const tiles = [
    { label: segment ? `${segment}` : "Contacts", value: data.totals.contacts.toLocaleString() },
    { label: "Open deals", value: money(data.totals.openValue) },
    { label: "To do today", value: String(due.filter((d) => d.date <= today()).length) },
    { label: "Won this month", value: money(data.totals.wonMonth) },
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
            <button className={quiet} onClick={() => exportAll(segment).then((m) => setError(m), (e) => setError(e instanceof Error ? e.message : "Couldn't export."))}>Export</button>
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
        <SegmentBar
          data={data}
          segment={segment}
          onPick={(s) => (setSegment(s), setSegMsg(null))}
          msg={segMsg}
          onWrite={async () => {
            setSegMsg(`Writing first emails for ${segment}...`);
            try {
              const out = await post<{ written: number; failed: string[]; left: number }>({ action: "draftSegment", segment });
              setSegMsg(
                out.written
                  ? `${out.written} first email${out.written > 1 ? "s" : ""} written for ${segment}, waiting under To do for your Send click.${out.left ? " Click again for the next ones." : ""}`
                  : out.failed[0] ?? `Every new ${segment} contact with an email already has a first email.`,
              );
              load();
            } catch (e) {
              setSegMsg(e instanceof Error ? e.message : "Couldn't write them.");
            }
          }}
        />
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
        <div className="mt-4">
          {view === "pipeline" && (
            <>
              <div className="mb-2 flex items-center gap-2 text-sm text-dash-muted">
                <span>Show</span>
                <select
                  className={`${field} w-auto py-1`}
                  value={cards}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setCards(n);
                    try {
                      localStorage.setItem("crm_cards", String(n));
                    } catch {
                      /* remembered for this visit only */
                    }
                  }}
                >
                  {CARD_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <span>per stage</span>
              </div>
              <Pipeline data={data} cards={cards} onOpen={setOpen} onChanged={load} onError={setError} />
            </>
          )}
          {view === "contacts" && <ContactList data={data} segment={segment} stage={listStage} onStage={setListStage} onOpen={setOpen} />}
          {view === "todo" && <TodoList data={data} items={due} onOpen={setOpen} onChanged={load} onError={setError} />}
          {view === "templates" && <Templates data={data} onChanged={load} onError={setError} />}
        </div>
      </Card>
      {open && <ContactPanel id={open} data={data} onClose={() => setOpen(null)} onChanged={load} onOpenId={setOpen} />}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} onDone={load} />}
      {showArchived && <ArchivedDialog onClose={() => setShowArchived(false)} onDone={load} />}
      {showStages && <StagesDialog stages={data.stages} settings={data.settings} templates={data.templates} onClose={() => setShowStages(false)} onDone={load} />}
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

function Pipeline({ data, cards, onOpen, onChanged, onError }: { data: CrmData; cards: number; onOpen: (id: string) => void; onChanged: () => void; onError: (e: string | null) => void }) {
  // Each stage pages on its own: page 0 comes with the board, later pages are read from the database.
  const [pages, setPages] = useState<Record<string, { page: number; list: Contact[] }>>({});
  useEffect(() => setPages({}), [data, cards]);
  const turn = async (stage: string, page: number) => {
    if (page === 0) return setPages((p) => ({ ...p, [stage]: { page: 0, list: [] } }));
    try {
      const q = new URLSearchParams({ search: "1", stage, segment: data.segment, page: String(page), size: String(cards) });
      const d = await apiFresh<{ contacts: Contact[]; total: number }>(`/api/crm?${q}`);
      setPages((p) => ({ ...p, [stage]: { page, list: d.contacts } }));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't load that page.");
    }
  };
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
        // A page of the stage's contacts in the chosen segment, newest first; the count and value cover everyone in it.
        const pg = pages[s]?.page ?? 0;
        const list = pg
          ? pages[s]!.list
          : data.contacts
              .filter((c) => c.stage === s && (!data.segment || c.segment === data.segment))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, cards);
        const count = data.stageCounts[s] ?? { n: list.length, value: list.reduce((n, c) => n + c.value, 0) };
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
              <p className="text-xs text-dash-muted">{count.n.toLocaleString()} · {money(count.value)}</p>
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
                  {pitchFor(data, c).length > 0 && <p className="mt-1 text-xs text-dash-green">Pitch: {pitchFor(data, c).map((x) => x.name).join(", ")}</p>}
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
              {count.n > cards && (
                <div className="flex items-center justify-between gap-1 px-1 text-xs text-dash-muted">
                  <button className={`${quiet} px-2 py-1 text-xs`} disabled={!pg} onClick={() => turn(s, pg - 1)}>Previous</button>
                  <span>{(pg * cards + 1).toLocaleString()} to {Math.min((pg + 1) * cards, count.n).toLocaleString()} of {count.n.toLocaleString()}</span>
                  <button className={`${quiet} px-2 py-1 text-xs`} disabled={(pg + 1) * cards >= count.n} onClick={() => turn(s, pg + 1)}>Next</button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Segments as buttons with their counts, and for the chosen one, its first emails written in one click. */
function SegmentBar({ data, segment, onPick, onWrite, msg }: { data: CrmData; segment: string; onPick: (s: string) => void; onWrite: () => void; msg: string | null }) {
  // Segments in settings, plus any a contact still carries (from an import or a removed segment), so nobody is hidden.
  const segs = [...new Set([...(data.settings.segments ?? []), ...Object.keys(data.segmentCounts).filter((k) => k)])];
  const all = Object.values(data.segmentCounts).reduce((a, n) => a + n, 0);
  const none = data.segmentCounts[""] ?? 0;
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-sm ${on ? "border-dash-green bg-dash-green text-white" : "border-dash-line text-dash-ink hover:bg-black/5"}`;
  if (!segs.length) return <p className="mt-3 text-xs text-dash-muted">Group your contacts, like Chiropractors or Naturopaths: add segments under Settings.</p>;
  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        <button className={chip(!segment)} onClick={() => onPick("")}>Everyone ({all.toLocaleString()})</button>
        {segs.map((x) => (
          <button key={x} className={chip(segment === x)} onClick={() => onPick(x)}>{x} ({(data.segmentCounts[x] ?? 0).toLocaleString()})</button>
        ))}
        {none > 0 && <span className="self-center text-xs text-dash-muted">{none.toLocaleString()} without a segment</span>}
      </div>
      {segment && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <button className={quiet} onClick={onWrite}>Write first emails for {segment}</button>
          <span className="text-xs text-dash-muted">
            {data.templates.some((t) => t.segment === segment) ? `Uses your ${segment} template.` : `Add a template for ${segment} under Email templates to use your own words.`} Nothing is sent until you click Send.
          </span>
        </div>
      )}
      {msg && <p className="mt-2 text-sm text-dash-ink">{msg}</p>}
    </div>
  );
}

/** The contact list, searched and paged in the database, so it stays quick with any number of contacts. */
function ContactList({ data, segment, stage, onStage, onOpen }: { data: CrmData; segment: string; stage: string; onStage: (s: string) => void; onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [reach, setReach] = useState("");
  const [page, setPage] = useState(0);
  const [res, setRes] = useState<{ contacts: Contact[]; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setPage(0), [q, tag, reach, stage, segment]);
  useEffect(() => {
    // Only the newest search's answer is shown; a slower earlier one is ignored.
    let current = true;
    const t = setTimeout(() => {
      const p = new URLSearchParams({ search: "1", q, stage, segment, tag, reach, page: String(page) });
      apiFresh<{ contacts: Contact[]; total: number }>(`/api/crm?${p}`)
        .then((d) => current && (setRes(d), setErr(null)))
        .catch((e) => current && setErr(e instanceof Error ? e.message : "Couldn't search."));
    }, 250);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [q, tag, reach, stage, segment, page, data]);
  const from = page * 50;
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <input className={`${field} max-w-xs`} placeholder="Search name, company, email, phone or type" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${field} w-auto`} value={stage} onChange={(e) => onStage(e.target.value)}>
          <option value="">All stages</option>
          {data.stages.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={`${field} w-auto`} value={reach} onChange={(e) => setReach(e.target.value)}>
          <option value="">Email or phone</option>
          <option value="email">Has an email</option>
          <option value="phone">Phone only</option>
        </select>
        <input className={`${field} w-40`} placeholder="Tag" value={tag} onChange={(e) => setTag(e.target.value)} />
      </div>
      {err && <p className="mb-2 text-sm text-dash-down">{err}</p>}
      {!res ? (
        <p className="text-sm text-dash-muted">Loading...</p>
      ) : !res.total && !q && !stage && !tag && !reach && !segment ? (
        <p className="text-sm text-dash-muted">No contacts yet. Click Add contact, or Import a spreadsheet. Requests from your website forms are added here on their own.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-dash-muted">
              <tr><th className="py-2">Name</th><th>Company</th><th>Segment</th><th>Stage</th><th>Last contact</th><th>Follow up</th></tr>
            </thead>
            <tbody>
              {res.contacts.map((c) => (
                <tr key={c.id} className="cursor-pointer border-t border-dash-line hover:bg-black/[0.03]" onClick={() => onOpen(c.id)}>
                  <td className="py-2 pr-2">
                    <p className="font-semibold text-dash-ink">{c.name || c.email || c.company || "No name"}</p>
                    <p className="text-xs text-dash-muted">{c.email || c.phone}</p>
                  </td>
                  <td className="pr-2 text-dash-ink">{c.company}</td>
                  <td className="pr-2 text-dash-muted">{c.segment}</td>
                  <td className="pr-2 text-dash-ink">{c.stage}</td>
                  <td className="pr-2 text-dash-muted">{c.lastContactAt ? shortDate(c.lastContactAt) : "Never"}</td>
                  <td className={`pr-2 ${c.followUp && c.followUp <= today() ? "font-semibold text-dash-down" : "text-dash-muted"}`}>{c.followUp ? shortDate(c.followUp) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!res.contacts.length && <p className="mt-2 text-sm text-dash-muted">No contact matches that search.</p>}
          {res.total > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-dash-muted">
              <span>{(from + 1).toLocaleString()} to {Math.min(from + 50, res.total).toLocaleString()} of {res.total > 10000 ? "10,000 or more" : res.total.toLocaleString()}</span>
              <button className={quiet} disabled={!page} onClick={() => setPage(page - 1)}>Previous</button>
              <button className={quiet} disabled={res.contacts.length < 50 || (res.total <= 10000 && from + 50 >= res.total)} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
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
        Write an email once and reuse it. In the subject or message, {"{first_name}"} (like Ana, or Dr. Hamer for a doctor), {"{name}"}, {"{company}"} and {"{product}"} (the product that fits that practice best) are filled in for each contact.
      </p>
      <ul className="space-y-2">
        {data.templates.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dash-line p-3 text-sm">
            <div className="min-w-0">
              <p className="font-semibold text-dash-ink">{t.name}</p>
              <p className="text-xs text-dash-muted break-words">{t.subject}</p>
              {t.segment && <p className="text-xs font-semibold text-dash-green">First email for {t.segment}</p>}
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
      {!edit && <button className={`${primary} mt-3`} onClick={() => setEdit({ name: "", subject: "", body: "", segment: "" })}>New template</button>}
      {edit && (
        <div className="mt-3 space-y-2 rounded-xl border border-dash-line p-3">
          <input className={field} placeholder="Template name, like Clinic intro" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <input className={field} placeholder="Subject" value={edit.subject ?? ""} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
          <textarea className={`${field} min-h-[160px]`} placeholder="Hi {first_name}," value={edit.body ?? ""} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
          {(data.settings.segments ?? []).length > 0 && (
            <label className="block text-xs text-dash-muted">Use as the first email for
              <select className={field} value={edit.segment ?? ""} onChange={(e) => setEdit({ ...edit, segment: e.target.value })}>
                <option value="">No segment</option>
                {data.settings.segments.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
          )}
          <div className="flex gap-2">
            <button className={primary} onClick={save}>Save template</button>
            <button className={quiet} onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const EMPTY: Partial<Contact> = { name: "", email: "", phone: "", company: "", title: "", kind: "", segment: "", stage: "", value: 0, tags: [], address: "", website: "", followUp: null };

function ContactPanel({ id, data, onClose, onChanged, onOpenId }: { id: string; data: CrmData; onClose: () => void; onChanged: () => void; onOpenId: (id: string) => void }) {
  const [contact, setContact] = useState<Partial<Contact>>(id === "new" ? { ...EMPTY, stage: data.stages[0] } : {});
  const [acts, setActs] = useState<Activity[]>([]);
  const [editing, setEditing] = useState(id === "new");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "note" | "call" | "meeting" | "reply" | "task"; subject: string; body: string; due: string } | null>(null);
  const [stock, setStock] = useState<StockLine[]>([]);
  const [orders, setOrders] = useState<ContactOrders | "access" | "failed" | null>(null);
  const [files, setFiles] = useState<ContactFile[]>([]);
  const [mail, setMail] = useState(false);
  // Tags are typed as one line and split on commas when saved, so typing never jumps or adds spaces.
  const [tagText, setTagText] = useState("");
  const loadOne = useCallback(async () => {
    if (id === "new") return;
    const t = await apiFresh<{ contact: Contact; activities: Activity[]; stock: StockLine[]; files: ContactFile[]; orders: ContactOrders | "access" | "failed" | null }>(`/api/crm?contact=${id}`);
    setFiles(t.files ?? []);
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
            <label className="text-xs text-dash-muted">Segment
              <select className={field} value={c.segment ?? ""} onChange={(e) => set("segment", e.target.value)}>
                <option value="">None</option>
                {[...new Set([...(data.settings.segments ?? []), ...(c.segment ? [c.segment] : [])])].map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
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
              ["Segment", c.segment],
              ["Products to pitch", pitchFor(data, c as Contact, 3).map((x) => `${x.name} (fits: ${x.why.join(", ")})`).join("; ")],
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
        {id !== "new" && !editing && <Files contactId={id} files={files} busy={busy} run={run} />}

        {id !== "new" && !editing && !mail && c.draft && (
          <div className="mt-4 rounded-xl border border-dash-green bg-dash-green/5 p-3 text-sm">
            <p className="font-semibold text-dash-ink">{c.draft.kind === "followup" ? "A follow up is written and ready" : "An email is written and ready"}</p>
            <p className="mt-1 text-dash-ink break-words">{c.draft.subject}</p>
            <p className="mt-1 text-xs text-dash-muted">
              {c.draft.checked === "ai" ? "Checked by a second AI. Read it before you send." : c.draft.checked === "template" ? "Your own template, with the names filled in. Read it before you send." : "No second AI was free to check it. Read it carefully before you send."}
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
    .replace(/\{company\}/gi, plainCompany(contact.company) || "your business")
    .replace(/\{product\}/gi, pitchFor(data, contact, 1)[0]?.name || "our products");
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
  // Rows are mapped a batch at a time, so a file with millions of rows never has to be held twice.
  const count = table ? table.length - 1 : 0;
  const first = table ? mapRows([table[0], table[1] ?? []], mapping)[0] : undefined;
  const used = (key: string, i: number) => key && key !== "note" && mapping.some((m, j) => m === key && j !== i);
  const stop = useRef(false);
  useEffect(() => () => void (stop.current = true), []);
  const go = async () => {
    if (!table || !count) return;
    setBusy(true);
    stop.current = false;
    const total = { added: 0, updated: 0, skipped: 0 };
    const BATCH = 1000;
    try {
      // In batches of up to 1,000 rows and about 2 MB, each saved before the next, so a stop part way keeps everything
      // already added and no batch is too big to send.
      for (let i = 1; i < table.length; ) {
        if (stop.current) break;
        const batch: Record<string, string>[] = [];
        let size = 0;
        for (const r of mapRows([table[0], ...table.slice(i, i + BATCH)], mapping)) {
          const row = { ...r, notes: r.notes.slice(0, 2000) };
          const n = new TextEncoder().encode(JSON.stringify(row)).length;
          if (batch.length && size + n > 2_000_000) break;
          batch.push(row);
          size += n;
        }
        i += batch.length || 1;
        setMsg(`Importing ${Math.min(i - 1, count).toLocaleString()} of ${count.toLocaleString()}...`);
        const out = await post<{ result: { added: number; updated: number; skipped: number } }>({ action: "import", rows: batch });
        total.added += out.result.added;
        total.updated += out.result.updated;
        total.skipped += out.result.skipped;
      }
      setMsg(`Added ${total.added.toLocaleString()}, filled in ${total.updated.toLocaleString()} that were already here, skipped ${total.skipped.toLocaleString()} without a name, company, phone or valid email.`);
      setTable(null);
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : "The import stopped."} ${total.added.toLocaleString()} were added before it stopped.`);
    }
    onDone();
    setBusy(false);
  };
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
            {count.toLocaleString()} rows{count > 5000 ? ". Big files import in batches of 1,000; keep this window open until it finishes" : ""}.
            {first ? ` First one: ${[first.name, first.company, first.email, first.phone].filter(Boolean).join(", ") || "nothing to add, check the columns above"}.` : ""}
          </p>
          <button disabled={busy || !count} className={`${primary} mt-2`} onClick={go}>{busy ? "Importing..." : "Import"}</button>
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

function StagesDialog({ stages, settings, templates, onClose, onDone }: { stages: string[]; settings: CrmSettings; templates: Template[]; onClose: () => void; onDone: () => void }) {
  const [list, setList] = useState(stages.join("\n"));
  const [days, setDays] = useState(String(settings.followUpDays));
  const [daily, setDaily] = useState(settings.dailyEmail);
  const [auto, setAuto] = useState(settings.autoDraft);
  const [offer, setOffer] = useState(settings.offer);
  const [link, setLink] = useState(settings.link);
  const [signoff, setSignoff] = useState(settings.signoff);
  const [segs, setSegs] = useState((settings.segments ?? []).join("\n"));
  const [products, setProducts] = useState(productsToLines(settings.products ?? []));
  const [firstTemplate, setFirstTemplate] = useState(templates.some((t) => t.id === settings.firstTemplate) ? settings.firstTemplate : "");
  const [findOn, setFindOn] = useState(settings.finder?.on ?? false);
  const [kinds, setKinds] = useState((settings.finder?.kinds ?? []).join("\n"));
  const [places, setPlaces] = useState((settings.finder?.places ?? []).join("\n"));
  const [perWeek, setPerWeek] = useState(String(settings.finder?.perWeek ?? 25));
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!/^\d+$/.test(days.trim())) return setErr("Put a number of days for follow ups, 0 to turn them off.");
    try {
      const finder = { on: findOn, kinds: kinds.split("\n"), places: places.split("\n"), perWeek: Number(perWeek) };
      await post({ action: "settings", settings: { followUpDays: Number(days), dailyEmail: daily, autoDraft: auto, offer, link, signoff, finder, firstTemplate, segments: segs.split("\n"), products: productsFromLines(products) } });
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
      <p className="mt-4 text-sm font-semibold text-dash-ink">Segments</p>
      <p className="text-sm text-dash-muted">The groups you work contacts in, one per line, like Chiropractors or Naturopaths. New businesses and imports are put in the right one by their type when it is clear.</p>
      <textarea className={`${field} mt-2 min-h-[110px]`} placeholder={"Chiropractors\nNaturopaths"} value={segs} onChange={(e) => setSegs(e.target.value)} />
      <p className="mt-4 text-sm font-semibold text-dash-ink">Your products and who they fit</p>
      <p className="text-sm text-dash-muted">
        One product per line: its name, a colon, then single words for the practices or interests it fits. Each contact is matched by its type, segment and name, and shows the products to pitch.
      </p>
      <textarea className={`${field} mt-2 min-h-[160px]`} placeholder={"Magnesium Complex: chiropract, sports, sleep, muscle"} value={products} onChange={(e) => setProducts(e.target.value)} />
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
        First emails
        <select className={`${field} mt-1`} value={firstTemplate} onChange={(e) => setFirstTemplate(e.target.value)}>
          <option value="">Written by the AI around your offer below</option>
          {templates.map((t) => <option key={t.id} value={t.id}>Your template, word for word: {t.name}</option>)}
        </select>
      </label>
      <p className="mt-1 text-xs text-dash-muted">With a template, {"{first_name}"} becomes Dr. and the last name for doctors, and {"{company}"} the practice name. Follow ups are still written for you.</p>
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
      <p className="mt-4 text-sm font-semibold text-dash-ink">Find new businesses for me</p>
      <label className="mt-1 flex items-center gap-2 text-sm text-dash-ink">
        <input type="checkbox" checked={findOn} onChange={(e) => setFindOn(e.target.checked)} />
        Each week, find businesses you sell to on Google Maps and add them here as new contacts
      </label>
      <p className="mt-1 text-xs text-dash-muted">
        Only real listings, with the email each business prints on its own website. Ones with an email get a first email written for your Send click; the others get a call task. Nothing is sent by itself.
      </p>
      {findOn && (
        <>
          <label className="mt-2 block text-sm text-dash-ink">
            Kinds of businesses, one per line
            <textarea className={`${field} mt-1 min-h-[80px]`} placeholder={"chiropractor\nnaturopathic doctor"} value={kinds} onChange={(e) => setKinds(e.target.value)} />
          </label>
          <label className="mt-2 block text-sm text-dash-ink">
            Where, one place per line
            <textarea className={`${field} mt-1 min-h-[80px]`} placeholder={"Dallas, TX\nPlano, TX"} value={places} onChange={(e) => setPlaces(e.target.value)} />
          </label>
          <label className="mt-2 block text-sm text-dash-ink">
            New businesses a week at most
            <input type="number" min={5} max={100} className={`${field} mt-1 w-24`} value={perWeek} onChange={(e) => setPerWeek(e.target.value)} />
          </label>
        </>
      )}
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

const FILE_KIND_LIST = ["Contract", "Tax form", "Invoice", "Folder", "Other"];
const sizeText = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

function Files({ contactId, files, busy, run }: {
  contactId: string;
  files: ContactFile[];
  busy: boolean;
  run: (body: Record<string, unknown>, after?: () => void) => Promise<void>;
}) {
  const [adding, setAdding] = useState<{ mode: "upload" | "link"; kind: string; name: string; url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Fetched (so the app's sign in goes with it, inside Shopify admin too), then saved as a download.
  const download = async (f: ContactFile) => {
    setErr(null);
    try {
      const res = await fetch(`/api/crm?file=${f.id}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "That file couldn't be opened.");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That file couldn't be opened.");
    }
  };
  const upload = async (f: File) => {
    setErr(null);
    if (f.size > 3_000_000) return setErr("Files up to 3 MB can be kept here. For bigger files, put them in Google Drive and add the link.");
    const data = await new Promise<string>((done, fail) => {
      const r = new FileReader();
      r.onload = () => done(String(r.result ?? ""));
      r.onerror = () => fail(new Error("That file couldn't be read."));
      r.readAsDataURL(f);
    }).catch((e) => (setErr(e.message), ""));
    if (data) await run({ action: "upload", id: contactId, file: { name: f.name, kind: adding?.kind ?? "Other", data } }, () => setAdding(null));
  };
  return (
    <div className="mt-4 rounded-xl border border-dash-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-dash-ink">Files</p>
        {!adding && (
          <div className="flex gap-2">
            <button className={quiet} onClick={() => setAdding({ mode: "upload", kind: "Contract", name: "", url: "" })}>Upload</button>
            <button className={quiet} onClick={() => setAdding({ mode: "link", kind: "Folder", name: "", url: "" })}>Add a link</button>
          </div>
        )}
      </div>
      {!files.length && !adding && <p className="text-sm text-dash-muted">Contracts, tax forms, invoices, or a link to their Google Drive folder.</p>}
      {adding && (
        <div className="mt-2 space-y-2">
          <select className={field} value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value })}>
            {FILE_KIND_LIST.filter((k) => adding.mode === "link" || k !== "Folder").map((k) => <option key={k}>{k}</option>)}
          </select>
          {adding.mode === "upload" ? (
            <>
              <input type="file" className="text-sm" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              <p className="text-xs text-dash-muted">PDF, Word, Excel, CSV, text or image, up to 3 MB.</p>
            </>
          ) : (
            <>
              <input className={field} placeholder="https://drive.google.com/..." value={adding.url} onChange={(e) => setAdding({ ...adding, url: e.target.value })} />
              <input className={field} placeholder="Name (optional), like Signed consignment agreement" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
              <button disabled={busy || !adding.url} className={primary} onClick={() => run({ action: "fileLink", id: contactId, file: { url: adding.url.trim(), kind: adding.kind, name: adding.name } }, () => setAdding(null))}>Save link</button>
            </>
          )}
          <button className={quiet} onClick={() => { setAdding(null); setErr(null); }}>Cancel</button>
        </div>
      )}
      {err && <p className="mt-2 text-sm text-dash-down">{err}</p>}
      <ul className="mt-2 space-y-1 text-sm">
        {files.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-black/5 px-1.5 py-0.5 text-xs text-dash-muted">{f.kind}</span>
            {f.url ? (
              <a className="min-w-0 break-words font-semibold text-dash-green hover:underline [overflow-wrap:anywhere]" href={f.url} target="_blank" rel="noopener noreferrer">
                {f.name}
              </a>
            ) : (
              <button className="min-w-0 break-words text-left font-semibold text-dash-green hover:underline [overflow-wrap:anywhere]" onClick={() => download(f)}>
                {f.name}
              </button>
            )}
            <span className="text-xs text-dash-muted">{f.url ? "link" : sizeText(f.size)}, {shortDate(f.at)}</span>
            <button className="text-xs text-dash-muted hover:text-dash-down" disabled={busy} onClick={() => window.confirm(`Remove ${f.name}?`) && run({ action: "deleteFile", fileId: f.id })}>Remove</button>
          </li>
        ))}
      </ul>
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
/** Exports the contacts in the chosen segment (up to 5,000), read from the database. */
async function exportAll(segment: string) {
  const p = new URLSearchParams({ search: "1", export: "1", segment });
  const d = await apiFresh<{ contacts: Contact[]; total: number }>(`/api/crm?${p}`);
  exportCsv(d.contacts);
  return d.total > d.contacts.length ? `Exported the first ${d.contacts.length.toLocaleString()} of ${d.total > 10000 ? "more than 10,000" : d.total.toLocaleString()}. ${segment ? "Use the Contacts tab to narrow it further." : "Pick a segment to export the rest in parts."}` : null;
}

function exportCsv(contacts: Contact[]) {
  const head = ["Name", "Email", "Phone", "Company", "Title", "Type", "Segment", "Stage", "Value", "Tags", "Follow up", "Last contact", "Website", "Address", "Came from", "Added"];
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  // A cell starting with = + @ or a minus sign would run as a formula in a spreadsheet; a leading apostrophe stops it.
  const safe = (v: string) => esc(/^[=+@\-\t\r]/.test(v) ? `'${v}` : v);
  const lines = [head.join(",")].concat(
    contacts.map((c) =>
      [c.name, c.email, c.phone, c.company, c.title, c.kind, c.segment, c.stage, c.value ? String(c.value) : "", c.tags.join("; "), c.followUp ?? "", c.lastContactAt?.slice(0, 10) ?? "", c.website, c.address, c.source, c.createdAt.slice(0, 10)]
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
