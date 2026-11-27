"use client";

import { useCallback, useEffect, useState } from "react";
import type { Campaign, NewsletterSettingsView, Subscriber, SubscriberStatus } from "@/lib/analytics/newsletter";
import { api, apiFresh } from "./seo-ui";
import { Card, ConfirmButton } from "./ui";
import { MemberNote, OwnerOnly, useIsMember } from "./team-role";
import { NewsletterMetrics } from "./NewsletterMetrics";

interface NewsletterData {
  settings: NewsletterSettingsView;
  missing: string[];
  counts: Record<SubscriberStatus, number>;
  sentToday: number;
  subscribers: Subscriber[];
  campaigns: Campaign[];
  ownerEmail: string | null;
  hasStore: boolean;
  webhookUrl: string;
}

const btn = "rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-60";
const primary = `${btn} bg-dash-green text-white hover:bg-dash-deep`;
const quiet = `${btn} border border-dash-line text-dash-ink hover:bg-black/5`;
const field = "w-full rounded-lg border border-dash-line px-3 py-2 text-sm text-dash-ink";
const n = (v: number) => v.toLocaleString("en-US");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

const STATUS_LABEL: Record<Campaign["status"], string> = {
  draft: "Draft",
  approved: "Approved, sending soon",
  sending: "Sending",
  sent: "Sent",
  failed: "Stopped by a problem",
  stopped: "Paused",
};
const SUB_LABEL: Record<SubscriberStatus, string> = { subscribed: "Subscribed", unsubscribed: "Unsubscribed", bounced: "Bounced", complained: "Marked as spam" };
const SOURCE_LABEL: Record<Subscriber["source"], string> = { shopify: "Shopify", import: "Imported", signup: "Signed up", manual: "Added by you" };

const post = <T,>(body: unknown) => api<T>("/api/newsletter", body);

/** The site's newsletter: sent through the owner's own Resend account, only after the owner approves each email. */
export function Newsletter({ active = true }: { active?: boolean }) {
  const [data, setData] = useState<NewsletterData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [loads, setLoads] = useState(0);
  const load = useCallback(async (search = q) => {
    try {
      setData(await apiFresh<NewsletterData>(`/api/newsletter${search ? `?q=${encodeURIComponent(search)}` : ""}`));
      setLoads((x) => x + 1);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the newsletter.");
    }
  }, [q]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  if (error && !data) return <Card className="mt-5"><p className="text-sm text-red-700">{error}</p></Card>;
  if (!data) return <Card className="mt-5"><p className="text-sm text-dash-muted">Loading your newsletter...</p></Card>;
  return (
    <div className="space-y-5">
      <Card className="mt-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-dash-muted">Subscribers</p>
            <p className="font-serif text-4xl text-dash-ink">{n(data.counts.subscribed)}</p>
            <p className="mt-1 text-xs text-dash-muted">
              {n(data.counts.unsubscribed)} unsubscribed, {n(data.counts.bounced)} bounced, {n(data.counts.complained)} marked as spam. Sent today: {n(data.sentToday)} of {n(data.settings.dailyCap)}.
            </p>
          </div>
        </div>
        <Checklist data={data} />
        <MemberNote text="Only the main sign in can change the newsletter settings, add people or approve a send. You can write emails and send yourself a test." />
      </Card>
      <NewsletterMetrics active={active} reload={loads} />
      <OwnerOnly note={null}>
        <SettingsCard data={data} onDone={() => load()} />
        <AutoCard data={data} onDone={() => load()} />
      </OwnerOnly>
      <Compose data={data} onDone={() => load()} />
      <Campaigns data={data} onDone={() => load()} />
      <Subscribers data={data} q={q} onSearch={(v) => { setQ(v); void load(v); }} onDone={() => load()} />
    </div>
  );
}

function Checklist({ data }: { data: NewsletterData }) {
  const s = data.settings;
  const items = [
    { done: s.keySaved, text: "Your Resend key" },
    { done: Boolean(s.fromAddress), text: "A from address, verified in Resend" },
    { done: Boolean(s.postalAddress.trim()), text: "Your business postal address" },
    { done: data.counts.subscribed > 0, text: "Your subscribers" },
  ];
  return (
    <ul className="mt-4 grid gap-2 sm:grid-cols-2">
      {items.map((i) => (
        <li key={i.text} className="flex items-center gap-2 text-sm">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${i.done ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>{i.done ? "Done" : "Needed"}</span>
          {i.text}
        </li>
      ))}
    </ul>
  );
}

function SettingsCard({ data, onDone }: { data: NewsletterData; onDone: () => void }) {
  const s = data.settings;
  const [open, setOpen] = useState(data.missing.length > 0);
  const [form, setForm] = useState({ fromName: s.fromName, fromAddress: s.fromAddress, replyTo: s.replyTo, postalAddress: s.postalAddress, dailyCap: String(s.dailyCap) });
  const [key, setKey] = useState("");
  const [hook, setHook] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setMsg(null);
    try {
      const out = await post<{ note: string | null }>({ action: "settings", settings: { ...form, dailyCap: Number(form.dailyCap), ...(key ? { resendKey: key } : {}), ...(hook ? { webhookSecret: hook } : {}), ...extra } });
      setKey("");
      setHook("");
      setMsg(out.note ?? "Saved.");
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't save.");
    }
    setBusy(false);
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-xl text-dash-ink">Sending settings</h2>
        <button className={quiet} onClick={() => setOpen(!open)}>{open ? "Hide" : "Change"}</button>
      </div>
      {!open && <p className="mt-2 text-sm text-dash-muted">{data.missing.length ? `Still needed: ${data.missing.join(", ")}.` : `Sending from ${s.fromAddress} through your own Resend account.`}</p>}
      {open && (
        <div className="mt-4 grid gap-4">
          <p className="text-sm text-dash-muted">
            Emails go out from your own Resend account (resend.com), so they come from your business and your sending reputation stays yours.
          </p>
          <label className="text-sm font-medium">
            Resend key {s.keySaved && <span className="ml-2 text-xs font-semibold text-green-700">Key saved</span>}
            <input type="password" autoComplete="off" className={`${field} mt-1`} value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.keySaved ? "Leave empty to keep the saved key" : "re_..."} />
            <span className="mt-1 block text-xs font-normal text-dash-muted">In Resend, open API Keys and create one with sending access. It is kept encrypted and never shown again.</span>
          </label>
          <label className="text-sm font-medium">
            From name
            <input className={`${field} mt-1`} value={form.fromName} onChange={set("fromName")} placeholder="Your business name" />
          </label>
          <label className="text-sm font-medium">
            From address
            <input className={`${field} mt-1`} value={form.fromAddress} onChange={set("fromAddress")} placeholder="news@news.yourdomain.com" />
            <span className="mt-1 block text-xs font-normal text-dash-muted">
              Use an address on a subdomain, like news@news.yourdomain.com, and verify that subdomain in Resend under Domains. If a newsletter is ever marked as spam, your everyday email stays safe.
            </span>
            {s.fromAddress && !s.subdomain && <span className="mt-1 block text-xs font-normal text-amber-700">This address is on your main domain. A subdomain is safer for newsletters.</span>}
          </label>
          <label className="text-sm font-medium">
            Replies go to
            <input className={`${field} mt-1`} value={form.replyTo} onChange={set("replyTo")} placeholder={data.ownerEmail ?? "you@yourdomain.com"} />
          </label>
          <label className="text-sm font-medium">
            Business postal address
            <textarea className={`${field} mt-1`} rows={3} value={form.postalAddress} onChange={set("postalAddress")} placeholder={"Street and number\nCity, State Zip"} />
            <span className="mt-1 block text-xs font-normal text-dash-muted">US law (CAN SPAM) needs it at the bottom of every marketing email. Nothing can be sent until it is here. A PO box works.</span>
          </label>
          <label className="text-sm font-medium">
            Most emails a day
            <input type="number" min={1} className={`${field} mt-1 max-w-[10rem]`} value={form.dailyCap} onChange={set("dailyCap")} />
            <span className="mt-1 block text-xs font-normal text-dash-muted">A bigger list is sent over several days. Keep it within your Resend plan.</span>
          </label>
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">Advanced: bounces and spam reports</summary>
            <p className="mt-2 text-dash-muted">
              In Resend, open Webhooks, add this address and pick these events: sent, delivered, delivery delayed, bounced, complained, opened and clicked. Then paste the signing secret here. People whose email bounced or who marked it as spam are never emailed again, and the Results show deliveries, opens and clicks.
            </p>
            <input readOnly className={`${field} mt-2 font-mono`} value={data.webhookUrl} onFocus={(e) => e.target.select()} />
            <label className="mt-2 block font-medium">
              Signing secret {s.webhookSaved && <span className="ml-2 text-xs font-semibold text-green-700">Secret saved</span>}
              <input type="password" autoComplete="off" className={`${field} mt-1`} value={hook} onChange={(e) => setHook(e.target.value)} placeholder="whsec_..." />
            </label>
          </details>
          <div className="flex flex-wrap gap-2">
            <button className={primary} disabled={busy} onClick={() => save()}>{busy ? "Saving..." : "Save"}</button>
            {s.keySaved && <ConfirmButton className={quiet} label="Remove the key" onConfirm={() => save({ removeKey: true })} />}
          </div>
          {msg && <p className="text-sm text-dash-muted">{msg}</p>}
        </div>
      )}
    </Card>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" });

/** Automatic sending: all off until the owner turns it on (owner only). */
function AutoCard({ data, onDone }: { data: NewsletterData; onDone: () => void }) {
  const s = data.settings;
  const [form, setForm] = useState({ welcomeOn: s.welcomeOn, weeklyOn: s.weeklyOn, weeklyAutoSend: s.weeklyAutoSend, weeklyDay: s.weeklyDay, weeklyHour: s.weeklyHour, timeZone: s.timeZone ?? "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const welcome = data.campaigns.find((c) => c.kind === "welcome" && (c.status === "approved" || c.status === "sending"));
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await post({ action: "settings", settings: { ...form, timeZone: form.timeZone.trim() } });
      setMsg("Saved.");
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't save.");
    }
    setBusy(false);
  };
  const box = (k: "welcomeOn" | "weeklyOn" | "weeklyAutoSend", text: string, sub: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
      <span>
        <span className="font-medium">{text}</span>
        <span className="block text-xs text-dash-muted">{sub}</span>
      </span>
    </label>
  );
  return (
    <Card>
      <h2 className="font-serif text-xl text-dash-ink">Automatic sending</h2>
      <p className="mt-1 text-sm text-dash-muted">Nothing goes out on its own unless you turn it on here. Pause works on every email, automatic ones too. Nothing is sent from Friday sundown to Saturday sundown.</p>
      <div className="mt-4 grid gap-4">
        {box("welcomeOn", "Welcome email", welcome ? `Each new subscriber gets "${welcome.subject}" once.` : "Write an email, tick This is my welcome email, send yourself a test and approve it. Then each new subscriber gets it once. People already on your list don't.")}
        {box("weeklyOn", "Weekly newsletter", "On your chosen day, the agent writes an email from your newest article that no newsletter used yet, with every check: the claim guard, AI wording, numbers in the article and a second AI. No new article, no email.")}
        {form.weeklyOn && (
          <div className="ml-6 grid gap-3 sm:grid-cols-3">
            <label className="text-xs font-medium">
              Day
              <select className={`${field} mt-1`} value={form.weeklyDay} onChange={(e) => setForm({ ...form, weeklyDay: Number(e.target.value) })}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium">
              Hour
              <select className={`${field} mt-1`} value={form.weeklyHour} onChange={(e) => setForm({ ...form, weeklyHour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium">
              Time zone
              <input className={`${field} mt-1`} value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} placeholder={data.hasStore ? "Your store's time zone" : "America/Chicago"} />
            </label>
          </div>
        )}
        {form.weeklyOn && box("weeklyAutoSend", "Send it on its own", "Only when every check passed and a second AI said yes. Otherwise it waits for your test and approval, and you are told on the team board.")}
        {s.weeklyPaused && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{s.weeklyPaused} Tick Weekly newsletter and save to start it again.</p>}
        {s.weeklyNote && <p className="text-xs text-dash-muted">Last weekly run: {s.weeklyNote}</p>}
        <div>
          <button className={primary} disabled={busy} onClick={save}>{busy ? "Saving..." : "Save"}</button>
        </div>
        {msg && <p className="text-sm text-dash-muted">{msg}</p>}
      </div>
    </Card>
  );
}

function Compose({ data, onDone }: { data: NewsletterData; onDone: () => void }) {
  const [subject, setSubject] = useState("");
  const [preview, setPreview] = useState("");
  const [body, setBody] = useState("");
  const [welcome, setWelcome] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (what: string, work: () => Promise<void>) => {
    setBusy(what);
    setMsg(null);
    try {
      await work();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That didn't work.");
    }
    setBusy(null);
  };
  return (
    <Card>
      <h2 className="font-serif text-xl text-dash-ink">Write an email</h2>
      <div className="mt-4 grid gap-3">
        <input className={field} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" maxLength={150} />
        <input className={field} value={preview} onChange={(e) => setPreview(e.target.value)} placeholder="Preview text, shown next to the subject in the inbox (optional)" maxLength={200} />
        <textarea className={field} rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your email here." />
        <p className="text-xs text-dash-muted">
          Leave a blank line between paragraphs. Start a line with # for a heading, or * for a list. Links look like [Read more](https://yoursite.com). Links to your own site get newsletter tags, so visits and sales from them can be counted. Your unsubscribe link and postal address are added at the bottom.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={welcome} onChange={(e) => setWelcome(e.target.checked)} />
          This is my welcome email: each new subscriber gets it once, after I approve it and turn it on.
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            className={primary}
            disabled={Boolean(busy)}
            onClick={() => run("save", async () => {
              await post({ action: "save", campaign: { subject, preview, body, kind: welcome ? "welcome" : "campaign" } });
              setSubject("");
              setPreview("");
              setBody("");
              setWelcome(false);
              setMsg("Saved as a draft below. Send yourself a test next.");
              onDone();
            })}
          >
            {busy === "save" ? "Saving..." : "Save draft"}
          </button>
          <button
            className={quiet}
            disabled={Boolean(busy)}
            onClick={() => run("draft", async () => {
              await post({ action: "draft" });
              setMsg("A draft from your latest article is below. Read it and change anything you like before you send it.");
              onDone();
            })}
          >
            {busy === "draft" ? "Writing..." : "Draft from my latest article"}
          </button>
        </div>
        {msg && <p className="text-sm text-dash-muted">{msg}</p>}
        {!data.settings.keySaved && <p className="text-xs text-dash-muted">You can write now and set up sending later.</p>}
      </div>
    </Card>
  );
}

function Campaigns({ data, onDone }: { data: NewsletterData; onDone: () => void }) {
  if (!data.campaigns.length) return null;
  return (
    <Card>
      <h2 className="font-serif text-xl text-dash-ink">Your emails</h2>
      <ul className="mt-3 divide-y divide-dash-line">
        {data.campaigns.map((c) => <CampaignRow key={c.id} c={c} data={data} onDone={onDone} />)}
      </ul>
    </Card>
  );
}

function CampaignRow({ c, data, onDone }: { c: Campaign; data: NewsletterData; onDone: () => void }) {
  // Approving a send is for the main sign in; a member's test goes to their own sign in email.
  const member = useIsMember();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ subject: c.subject, preview: c.preview, body: c.body });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (body: Record<string, unknown>, done?: (out: Record<string, unknown>) => string) => {
    setBusy(true);
    setMsg(null);
    try {
      const out = await post<Record<string, unknown>>({ ...body, id: c.id });
      if (done) setMsg(done(out));
      setEditing(false);
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That didn't work.");
    }
    setBusy(false);
  };
  const draft = c.status === "draft" || c.status === "stopped";
  const editable = (draft || c.status === "failed") && c.sent === 0 && c.unsure === 0;
  // A paused email carries on with the people still waiting for it; a new one goes to everyone subscribed now.
  const resume = c.status === "stopped" && Boolean(c.approvedAt);
  const subs = resume ? c.waiting : data.counts.subscribed;
  const welcome = c.kind === "welcome";
  const [later, setLater] = useState(false);
  const [at, setAt] = useState("");
  const scheduledIso = () => (later && at ? new Date(at).toISOString() : undefined);
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-dash-ink">
            {c.subject}
            {welcome && <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">Welcome email</span>}
            {c.kind === "weekly" && <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800">Weekly</span>}
            {c.auto && <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800">Sent on its own</span>}
          </p>
          <p className="text-xs text-dash-muted">
            {welcome && (c.status === "approved" || c.status === "sending")
              ? data.settings.welcomeOn ? "On: each new subscriber gets it once" : "Approved, but the welcome email is turned off in Automatic sending"
              : c.scheduledAt && c.status === "approved" ? `Scheduled for ${when(c.scheduledAt)}` : STATUS_LABEL[c.status]}
            {c.sent ? `, ${n(c.sent)} sent` : ""}
            {c.waiting ? `, ${n(c.waiting)} waiting` : ""}
            {c.unsure ? `, ${n(c.unsure)} not sure (never sent twice)` : ""}
            {c.finishedAt ? `, finished ${when(c.finishedAt)}` : ""}
            {c.checked === "ai" ? ". Checked by a second AI" : ""}
            {c.tested && draft ? ". Test sent" : ""}
          </p>
          {c.checked !== "ai" && c.sourceUrl && draft && (
            <p className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">No second AI was free to check this draft. Read every line before you approve.</p>
          )}
          {c.lastError && <p className="mt-1 text-xs text-red-700">{c.lastError}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {editable && <button className={quiet} disabled={busy} onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>}
          {draft && (
            <button className={quiet} disabled={busy || data.missing.length > 0} onClick={() => act({ action: "test" }, (o) => `Test sent to ${String(o.to)}. Check your inbox, then approve.`)}>
              Send me a test
            </button>
          )}
          {draft && !member && welcome && (
            <ConfirmButton
              className={primary}
              disabled={busy || !c.tested || data.missing.length > 0}
              label="Approve the welcome email"
              confirmLabel="Click again to approve"
              onConfirm={() => act({ action: "approve", count: 0 }, () => data.settings.welcomeOn ? "Approved. Each new subscriber gets it once from now on." : "Approved. Turn on the welcome email under Automatic sending to start it.")}
            />
          )}
          {draft && !member && !welcome && (
            <ConfirmButton
              className={primary}
              disabled={busy || !c.tested || data.missing.length > 0 || subs === 0 || (later && !at)}
              label={resume ? `Carry on: send to the ${n(subs)} still waiting` : later && at ? `Schedule for ${n(subs)} subscribers` : `Send to ${n(subs)} subscribers`}
              confirmLabel={`Click again to ${later && at ? "schedule" : "send"} to ${n(subs)}`}
              onConfirm={() => act({ action: "approve", count: subs, scheduledAt: scheduledIso() }, (o) => later && at ? `Approved. It goes out to ${n(Number(o.count))} subscribers from ${when(new Date(at).toISOString())}, up to ${n(data.settings.dailyCap)} a day.` : `Approved. It goes out to ${n(Number(o.count))} subscribers over the next hours, up to ${n(data.settings.dailyCap)} a day.`)}
            />
          )}
          {(c.status === "approved" || c.status === "sending" || c.status === "failed") && (
            <button className={quiet} disabled={busy} onClick={() => act({ action: "stop" }, () => "Paused. Nobody else gets it until you approve it again.")}>Pause</button>
          )}
          {c.status === "failed" && !member && <button className={primary} disabled={busy} onClick={() => act({ action: "retry" }, () => "Sending carries on within the hour.")}>Try again</button>}
          {editable && <ConfirmButton className={quiet} label="Delete" onConfirm={() => act({ action: "delete" })} />}
        </div>
      </div>
      {draft && !c.tested && !editing && <p className="mt-2 text-xs text-dash-muted">Send yourself a test first. Then you can approve it.</p>}
      {draft && !member && !welcome && !resume && c.tested && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} />
            Send later
          </label>
          {later && <input type="datetime-local" className="rounded-lg border border-dash-line px-2 py-1 text-xs" value={at} onChange={(e) => setAt(e.target.value)} />}
          {later && <span className="text-dash-muted">Your computer's time. It goes to who is subscribed when you approve it.</span>}
        </div>
      )}
      {editing && (
        <div className="mt-3 grid gap-2">
          <input className={field} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} maxLength={150} />
          <input className={field} value={form.preview} onChange={(e) => setForm({ ...form, preview: e.target.value })} maxLength={200} placeholder="Preview text (optional)" />
          <textarea className={field} rows={10} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          <div>
            <button className={primary} disabled={busy} onClick={() => act({ action: "save", campaign: form }, () => "Saved. Send yourself a new test before you approve it.")}>Save</button>
          </div>
        </div>
      )}
      {msg && <p className="mt-2 text-sm text-dash-muted">{msg}</p>}
    </li>
  );
}

function Subscribers({ data, q, onSearch, onDone }: { data: NewsletterData; q: string; onSearch: (q: string) => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [consent, setConsent] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [search, setSearch] = useState(q);
  type Result = { added: number; already: number; blocked: number; invalid: number; optedOut?: number; complete?: boolean };
  const said = (r: Result) =>
    [
      `Added ${n(r.added)}.`,
      r.already ? `${n(r.already)} were already on your list.` : "",
      r.blocked ? `${n(r.blocked)} had unsubscribed, bounced or marked an email as spam, so they were left off.` : "",
      r.invalid ? `${n(r.invalid)} weren't email addresses.` : "",
      r.optedOut ? `${n(r.optedOut)} unsubscribed in Shopify, so they are unsubscribed here too.` : "",
      r.complete === false ? "Your store has more customers than one go can read. Click again to carry on." : "",
    ].filter(Boolean).join(" ");
  const run = async (what: string, body: Record<string, unknown>) => {
    setBusy(what);
    setMsg(null);
    try {
      const out = await post<{ result: Result }>(body);
      setMsg(said(out.result));
      if (what !== "shopify") {
        setText("");
        setAgreed(false);
      }
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "The import didn't work.");
    }
    setBusy(null);
  };
  return (
    <Card>
      <h2 className="font-serif text-xl text-dash-ink">Subscribers</h2>
      <p className="mt-1 text-sm text-dash-muted">Only people who agreed to get your emails. Anyone who unsubscribed is never added back.</p>
      <OwnerOnly note={null}>
      {data.hasStore && (
        <div className="mt-4 rounded-xl border border-dash-line p-4">
          <p className="text-sm">Customers who said yes to email marketing in your Shopify store.</p>
          <button className={`${primary} mt-2`} disabled={Boolean(busy)} onClick={() => run("shopify", { action: "shopify" })}>
            {busy === "shopify" ? "Reading your store..." : "Import from Shopify"}
          </button>
        </div>
      )}
      <div className="mt-4 rounded-xl border border-dash-line p-4">
        <p className="text-sm">Paste email addresses (one per line), or choose a CSV file with an email column.</p>
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          className="mt-2 block text-sm"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
          }}
        />
        <textarea className={`${field} mt-2`} rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"ana@example.com\nBen Ortiz <ben@example.com>"} />
        <input className={`${field} mt-2`} value={consent} onChange={(e) => setConsent(e.target.value)} placeholder="Where they signed up, like the form at our shop counter (optional)" maxLength={200} />
        <label className="mt-2 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          These people agreed to get emails from my business.
        </label>
        <button className={`${primary} mt-2`} disabled={Boolean(busy) || !agreed || !text.trim()} onClick={() => run("import", { action: "import", text, confirmed: agreed, consent })}>
          {busy === "import" ? "Importing..." : "Import"}
        </button>
      </div>
      </OwnerOnly>
      {msg && <p className="mt-3 text-sm text-dash-muted">{msg}</p>}
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch(search.trim());
        }}
      >
        <input className={field} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find someone by email or name" />
        <button className={quiet} type="submit">Find</button>
      </form>
      <ul className="mt-3 divide-y divide-dash-line text-sm">
        {data.subscribers.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0 break-all">
              {s.name ? `${s.name}, ` : ""}{s.email}
              <span className="ml-2 text-xs text-dash-muted">{SUB_LABEL[s.status]}, {SOURCE_LABEL[s.source]}</span>
            </span>
            {s.status === "subscribed" && (
              <ConfirmButton
                className={quiet}
                label="Unsubscribe"
                onConfirm={async () => {
                  try {
                    await post({ action: "unsubscribe", id: s.id });
                    onDone();
                  } catch (e) {
                    setMsg(e instanceof Error ? e.message : "That didn't work.");
                  }
                }}
              />
            )}
          </li>
        ))}
        {!data.subscribers.length && <li className="py-2 text-dash-muted">{q ? "Nobody found." : "No subscribers yet."}</li>}
      </ul>
    </Card>
  );
}
