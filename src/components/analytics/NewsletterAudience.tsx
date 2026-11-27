"use client";

import { useState } from "react";
import { SEGMENT_LABEL, SEGMENTS, type Audience, type Segment } from "@/lib/analytics/newsletter-audience";
import type { Campaign, CrmCandidate, Subscriber } from "@/lib/analytics/newsletter";
import { api, apiFresh } from "./seo-ui";
import { useIsMember } from "./team-role";

const btn = "rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-60";
const primary = `${btn} bg-dash-green text-white hover:bg-dash-deep`;
const quiet = `${btn} border border-dash-line text-dash-ink hover:bg-black/5`;
const field = "w-full rounded-lg border border-dash-line px-3 py-2 text-sm text-dash-ink";
const n = (v: number) => v.toLocaleString("en-US");
const post = <T,>(body: unknown) => api<T>("/api/newsletter", body);

type Tab = "all" | "segment" | "chosen" | "crm" | "typed";
type PeopleResult = { added: number; included: number; skipped: { email: string; why: string }[]; count: number };

const STATUS_WORD: Record<string, string> = { subscribed: "on your list", unsubscribed: "unsubscribed", bounced: "email bounced", complained: "marked an email as spam" };

/** Segment checkboxes and the owner's tags, shared by an email's audience and the weekly newsletter's (pure view). */
export function SegmentChooser({ segments, tags, allTags, onChange }: {
  segments: Segment[];
  tags: string[];
  allTags: { tag: string; n: number }[];
  onChange: (segments: Segment[], tags: string[]) => void;
}) {
  const flip = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-3 text-sm">
        {SEGMENTS.map((sg) => (
          <label key={sg} className="flex items-center gap-1">
            <input type="checkbox" checked={segments.includes(sg)} onChange={() => onChange(flip(segments, sg), tags)} />
            {SEGMENT_LABEL[sg]}
          </label>
        ))}
      </div>
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-3 text-sm">
          {allTags.map((t) => (
            <label key={t.tag} className="flex items-center gap-1">
              <input type="checkbox" checked={tags.includes(t.tag)} onChange={() => onChange(segments, flip(tags, t.tag))} />
              Tag {t.tag} <span className="text-xs text-dash-muted">({n(t.n)})</span>
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-dash-muted">Anyone in at least one ticked group gets it. Opened or clicked, and hasn't opened the last 3, need open tracking on in Resend.</p>
    </div>
  );
}

/** Who one email goes to: everyone, groups and tags, chosen people, CRM contacts who agreed, or typed addresses. */
export function AudiencePicker({ c, allTags, onDone }: { c: Campaign; allTags: { tag: string; n: number }[]; onDone: () => void }) {
  const member = useIsMember();
  const a = c.audience;
  const [tab, setTab] = useState<Tab | null>(null);
  const [segments, setSegments] = useState<Segment[]>(a.type === "segment" ? a.segments : []);
  const [tags, setTags] = useState<string[]>(a.type === "segment" ? a.tags : []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Chosen people
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Subscriber[]>([]);
  const [picked, setPicked] = useState<string[]>(a.type === "people" ? a.ids : []);
  // CRM contacts
  const [contacts, setContacts] = useState<CrmCandidate[]>([]);
  const [crmPicked, setCrmPicked] = useState<string[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [consent, setConsent] = useState("");
  // Typed addresses
  const [typed, setTyped] = useState("");
  const [typedOk, setTypedOk] = useState(false);
  const [typedNote, setTypedNote] = useState("");

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(await work());
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That didn't work.");
    }
    setBusy(false);
  };
  const save = (audience: Audience | { type: "people"; ids: string[]; from: "chosen" }) =>
    run(async () => {
      const out = await post<{ count: number }>({ action: "audience", id: c.id, audience });
      return `Saved. It goes to ${n(out.count)} ${out.count === 1 ? "person" : "people"} on your list.`;
    });
  const told = (r: PeopleResult) =>
    [
      `Added ${n(r.included)} to this email${r.added ? `, ${n(r.added)} of them new on your list` : ""}. It now goes to ${n(r.count)} ${r.count === 1 ? "person" : "people"}.`,
      ...r.skipped.map((x) => `Skipped ${x.email}: ${x.why}.`),
    ].join(" ");
  const search = async () => {
    const d = await apiFresh<{ subscribers: Subscriber[] }>(`/api/newsletter?q=${encodeURIComponent(q.trim())}`);
    setFound(d.subscribers.filter((s) => s.status === "subscribed"));
  };
  const loadCrm = async () => {
    const d = await apiFresh<{ contacts: CrmCandidate[] }>(`/api/newsletter?crm=1&q=${encodeURIComponent(q.trim())}`);
    setContacts(d.contacts);
  };
  const tabs: { id: Tab; label: string; owner?: boolean }[] = [
    { id: "all", label: "All subscribers" },
    { id: "segment", label: "Groups and tags" },
    { id: "chosen", label: "Chosen people" },
    { id: "crm", label: "CRM contacts", owner: true },
    { id: "typed", label: "Type emails", owner: true },
  ];
  return (
    <div className="mt-3 rounded-xl border border-dash-line p-3">
      <p className="text-sm">
        <span className="font-semibold">Send to:</span> {c.audienceLabel}, {n(c.audienceCount)} {c.audienceCount === 1 ? "person" : "people"}
        <button className="ml-2 text-xs font-semibold text-dash-green hover:underline" onClick={() => setTab(tab ? null : "all")}>{tab ? "Close" : "Change"}</button>
      </p>
      {tab && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-2">
            {tabs.filter((t) => !t.owner || !member).map((t) => (
              <button key={t.id} className={tab === t.id ? primary : quiet} onClick={() => (setTab(t.id), setMsg(null))}>{t.label}</button>
            ))}
          </div>
          <div className="mt-3 grid gap-2">
            {tab === "all" && <button className={`${primary} w-fit`} disabled={busy} onClick={() => save({ type: "all" })}>Send to all subscribers</button>}
            {tab === "segment" && (
              <>
                <SegmentChooser segments={segments} tags={tags} allTags={allTags} onChange={(sg, tg) => (setSegments(sg), setTags(tg))} />
                <button className={`${primary} w-fit`} disabled={busy || (!segments.length && !tags.length)} onClick={() => save({ type: "segment", segments, tags })}>Save groups</button>
              </>
            )}
            {tab === "chosen" && (
              <>
                <div className="flex gap-2">
                  <input className={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find people on your list by email or name" />
                  <button className={quiet} onClick={() => void search()}>Find</button>
                </div>
                <ul className="max-h-60 divide-y divide-dash-line overflow-y-auto text-sm">
                  {found.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 py-1">
                      <input type="checkbox" checked={picked.includes(s.id)} onChange={() => setPicked(picked.includes(s.id) ? picked.filter((x) => x !== s.id) : [...picked, s.id])} />
                      <span className="break-all">{s.name ? `${s.name}, ` : ""}{s.email}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-dash-muted">{n(picked.length)} picked. Only people still subscribed get it.</p>
                <div className="flex gap-2">
                  <button className={primary} disabled={busy || !picked.length} onClick={() => save({ type: "people", ids: picked, from: "chosen" })}>Send to these {n(picked.length)}</button>
                  {picked.length > 0 && <button className={quiet} onClick={() => setPicked([])}>Clear</button>}
                </div>
              </>
            )}
            {tab === "crm" && (
              <>
                <p className="text-xs text-dash-muted">
                  Only people who agreed to get emails from you can get a newsletter. That keeps your business within spam law (CAN SPAM in the US, and stricter rules in Canada and Europe). Contacts already on your list are fine. For anyone else, tick that they agreed and say how.
                </p>
                <div className="flex gap-2">
                  <input className={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find CRM contacts by name, company or email" />
                  <button className={quiet} onClick={() => void loadCrm()}>Find</button>
                </div>
                <ul className="max-h-60 divide-y divide-dash-line overflow-y-auto text-sm">
                  {contacts.map((k) => {
                    const blocked = k.status && k.status !== "subscribed";
                    return (
                      <li key={k.contactId} className="flex items-center gap-2 py-1">
                        <input type="checkbox" disabled={Boolean(blocked)} checked={crmPicked.includes(k.contactId)} onChange={() => setCrmPicked(crmPicked.includes(k.contactId) ? crmPicked.filter((x) => x !== k.contactId) : [...crmPicked, k.contactId])} />
                        <span className="break-all">{[k.name, k.company].filter(Boolean).join(", ") || k.email} <span className="text-xs text-dash-muted">{k.email}, {k.status ? STATUS_WORD[k.status] : "not on your list yet"}</span></span>
                      </li>
                    );
                  })}
                </ul>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  The contacts not on my list yet agreed to get emails from my business.
                </label>
                <input className={field} value={consent} onChange={(e) => setConsent(e.target.value)} placeholder="How they agreed, like they asked for it at our trade show booth" maxLength={200} />
                <button className={`${primary} w-fit`} disabled={busy || !crmPicked.length} onClick={() => run(async () => told((await post<{ result: PeopleResult }>({ action: "crm", id: c.id, contactIds: crmPicked, agreed, consent })).result))}>
                  Add {n(crmPicked.length)} to this email
                </button>
              </>
            )}
            {tab === "typed" && (
              <>
                <textarea className={field} rows={4} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={"Up to 20 addresses, one per line\nana@example.com"} />
                <input className={field} value={typedNote} onChange={(e) => setTypedNote(e.target.value)} placeholder="How they asked or agreed (optional)" maxLength={200} />
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={typedOk} onChange={(e) => setTypedOk(e.target.checked)} />
                  These people asked for or agreed to get this email.
                </label>
                <p className="text-xs text-dash-muted">They join your list and get this email. Anyone who unsubscribed, bounced or marked an email as spam is skipped and never added back.</p>
                <button className={`${primary} w-fit`} disabled={busy || !typedOk || !typed.trim()} onClick={() => run(async () => told((await post<{ result: PeopleResult }>({ action: "typed", id: c.id, text: typed, confirmed: typedOk, consent: typedNote })).result))}>
                  Add to this email
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {msg && <p className="mt-2 text-sm text-dash-muted">{msg}</p>}
    </div>
  );
}
