"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { WeeklyReportData } from "@/lib/analytics/autopilot/alerts";
import { DonutChart } from "./DonutChart";
import { ArrowDownIcon, ArrowUpIcon } from "./Icons";
import { api, apiFresh } from "./seo-ui";
import { Card, CardHeader, Skeleton } from "./ui";

/** The product's goal for every site (CLAUDE.md), used before the first measurement. */
const GOAL = 20000;
const n = (v: number) => Math.round(v).toLocaleString("en-US");

/** This week's report as charts and cards, from the site's own data. The weekly email sends the same numbers. */
export function WeeklyReport({ auto = false }: { auto?: boolean }) {
  const [data, setData] = useState<WeeklyReportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function load(fresh = false) {
    setBusy(true);
    setErr(null);
    try {
      setData((await (fresh ? apiFresh : api)<{ data: WeeklyReportData }>("/api/autopilot/weekly-report")).data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The report couldn't be made right now.");
    } finally {
      setBusy(false);
    }
  }
  // On its own page the report is made as soon as it opens.
  useEffect(() => {
    if (auto) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  if (!data) {
    return (
      <Card className="mt-6">
        <CardHeader title="This week's report" />
        {busy ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
          </div>
        ) : (
          <button onClick={() => load()} className="rounded-full bg-dash-green px-3 py-1 text-xs font-semibold text-white">See this week&apos;s report</button>
        )}
        {err && <p className="mt-2 text-xs text-dash-down">{err}</p>}
      </Card>
    );
  }

  const traffic = Array.isArray(data.traffic) ? data.traffic : [];
  const visits = data.totals?.visits ?? 0;
  const leads = data.totals?.leads ?? 0;
  const sales = data.totals?.revenue ?? 0;
  const shownVisits = traffic.reduce((a, c) => a + c.now.sessions, 0);
  const withLeads = traffic.filter((c) => c.now.keyEvents > 0);
  const maxLeads = Math.max(0, ...withLeads.map((c) => c.now.keyEvents));
  const google = traffic.find((c) => c.name === "Organic Search");
  const shop = data.shopify && typeof data.shopify === "object" ? data.shopify : null;
  const shopNote =
    data.shopify === "access"
      ? "Reconnect your store under Content to allow reading orders."
      : data.shopify === "error"
        ? "Shopify couldn't be read. Left out, not guessed."
        : "Connect a Shopify store to count orders.";
  const goal = Number(data.visitors?.goal) > 0 ? Number(data.visitors?.goal) : GOAL;
  const bl = data.backlinks && typeof data.backlinks === "object" ? data.backlinks : null;

  return (
    <div className="mt-6 space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-dash-muted">Last 7 days, from your own Google data. The weekly email sends the same.</p>
        <button onClick={() => load(true)} disabled={busy} className="text-xs font-semibold text-dash-green hover:underline disabled:opacity-50">{busy ? "Updating..." : "Update"}</button>
      </div>

      {/* Headline cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Visits this week" value={traffic.length ? n(visits) : "None"} sub="all channels" />
        <Stat label="From Google this week" value={google ? n(google.now.sessions) : "None"} change={google ? [google.now.sessions, google.before.sessions] : undefined} />
        <Stat label="Leads and sales" value={data.totals ? n(leads) : "None"} sub={
            sales > 0
              ? `${n(sales)} in sales`
              : shop && shop.revenue > 0
                ? `${shop.capped ? "over " : ""}${n(shop.revenue)}${shop.currency ? ` ${shop.currency}` : ""} store sales in ${shop.days ?? 28} days`
                : !data.totals
                  ? "connect Google Analytics"
                  : "key events"
          }
        />
        <Stat label="Work done" value={n(data.week.changes + data.week.articles + data.week.links)} sub={`${data.week.changes} changes, ${data.week.articles} ${data.week.articles === 1 ? "article" : "articles"}, ${data.week.links} ${data.week.links === 1 ? "link" : "links"}`} />
      </div>

      {/* Sales straight from Shopify */}
      {/* Every account sees the same sections; a missing source shows what to connect, never a made up number. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Shopify orders (28 days)" value={shop ? `${shop.capped ? "Over " : ""}${n(shop.orders)}` : "None"} sub={shop ? `${n(shop.revenue)} ${shop.currency ?? ""} in sales` : shopNote} />
        <Stat label="Orders from Google search" value={shop ? n(shop.fromGoogle) : "None"} sub={shop ? `${n(shop.fromGoogleRevenue)} ${shop.currency ?? ""} in sales` : shopNote} />
        <Card className="sm:col-span-2">
          <p className="mb-2 text-sm text-dash-muted">Pages Google searchers bought from</p>
          {shop && shop.pages.length > 0 ? (
            <div className="space-y-2">
              {shop.pages.slice(0, 4).map((p) => (
                <Funnel key={p.path} label={p.path} value={p.orders} max={shop.pages[0].orders} />
              ))}
            </div>
          ) : (
            <Empty text={shop ? "No orders from Google yet." : shopNote} />
          )}
        </Card>
      </div>

      {/* Goal */}
      <Card>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="font-semibold text-dash-ink">Goal: {n(goal)} Google visitors a month</span>
          <span className="tabular-nums text-dash-muted">{data.visitors
              ? `${n(data.visitors.value)} Google clicks in the 28 days before ${new Date(data.visitors.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`
              : "Not measured yet"}</span>
        </div>
        <Bar value={data.visitors?.value ?? 0} max={goal} />
        <p className="mt-1 text-xs text-dash-muted">The long term goal every site works toward. The agents start with the easiest searches and aim higher as the site grows stronger.</p>
        <p className="mt-3 text-sm text-dash-ink">{data.focus || "The Strategist sets the focus with the next weekly plan."}</p>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Channels */}
        <Card>
          <CardHeader title="Where visits came from" />
          {traffic.length === 0 ? (
            <>
              <DonutChart slices={[]} centerValue={data.totals ? 0 : null} centerLabel="visits" />
              <Empty
                text={
                  data.traffic === "none"
                    ? "Connect Google Analytics in Settings."
                    : data.traffic === "error"
                      ? "Google Analytics couldn't be read. Left out, not guessed."
                      : "No visits recorded yet. They show here as they come in."
                }
              />
            </>
          ) : (
            <>
              <DonutChart
                slices={traffic.map((c) => ({ name: c.name, value: c.now.sessions, share: shownVisits ? (c.now.sessions / shownVisits) * 100 : 0 }))}
                centerValue={visits}
                centerLabel="visits"
              />
              {withLeads.length > 0 && (
                <div className="mt-5 space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-dash-muted">Leads and sales by channel</p>
                  {withLeads.map((c) => (
                    <Funnel key={c.name} label={c.name} value={c.now.keyEvents} max={maxLeads} />
                  ))}
                </div>
              )}
              {leads === 0 && <p className="mt-3 text-xs text-dash-muted">No leads recorded. Mark sign ups and orders as key events in Google Analytics.</p>}
            </>
          )}
        </Card>

        {/* Backlinks funnel */}
        <Card>
          <CardHeader title="Backlinks" />
          <div className="space-y-3">
            <Funnel label="Sites found" value={bl?.found ?? 0} max={bl?.found ?? 0} />
            <Funnel label="Emails ready" value={bl?.ready ?? 0} max={bl?.found ?? 0} />
            <Funnel label="Emailed" value={bl?.emailed ?? 0} max={bl?.found ?? 0} />
            <Funnel label="Links won" value={bl?.wonAll ?? 0} max={bl?.found ?? 0} note={bl?.wonWeek ? `${bl.wonWeek} this week` : undefined} />
            {bl && bl.fromLinks.length > 0 && (
              <p className="text-xs text-dash-muted">Visits from your links: {bl.fromLinks.map((x) => `${x.domain} ${x.visits}`).join(", ")}</p>
            )}
            {!bl && <Empty text={data.backlinks === "error" ? "Backlinks couldn't be read. Left out, not guessed." : "The backlink agent is looking for sites. They show here once found."} />}
          </div>
        </Card>
      </div>

      {/* Plan */}
      <Card>
        <CardHeader title="This week's plan" />
        {data.plan.length === 0 && <Empty text={data.planNote || "The Strategist writes the plan with the next weekly run."} />}
        <ol className="space-y-1.5">
            {data.plan.map((m, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-dash-green text-xs font-semibold text-white">{i + 1}</span>
                <span className="min-w-0 text-dash-ink">{m}</span>
              </li>
          ))}
        </ol>
      </Card>

      {/* Agents */}
      <Card>
        <CardHeader title="What each agent did" />
        {data.agents.length === 0 && <Empty text="The agents' work shows here after their first run." />}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.agents.map((a) => (
              <div key={a.agent} className="rounded-lg border border-dash-line bg-[#FBF8F2] px-3 py-2">
                <p className="text-xs font-semibold text-dash-ink">{a.agent}</p>
                <p className="text-sm text-dash-ink">{a.did}</p>
                {a.result && <p className="text-xs text-dash-muted">{a.result}</p>}
              </div>
            ))}
          </div>
      </Card>

      <p className="text-center text-xs text-dash-muted">A rise after a change is a good sign, not proof the change caused it.</p>
    </div>
  );
}

function Stat({ label, value, sub, change }: { label: string; value: string; sub?: string; change?: [number, number] }) {
  return (
    <Card>
      <p className="text-sm text-dash-muted">{label}</p>
      <p className="mt-1 font-serif text-3xl tabular-nums text-dash-ink">{value}</p>
      {change ? <Change now={change[0]} before={change[1]} /> : sub ? <p className="text-xs text-dash-muted">{sub}</p> : null}
    </Card>
  );
}

function Change({ now, before }: { now: number; before: number }) {
  if (!(before > 0)) return <span className="text-xs text-dash-muted">{now > 0 ? "new" : ""}</span>;
  const pct = Math.round(((now - before) / before) * 100);
  const up = pct >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums ${up ? "text-dash-up" : "text-dash-down"}`}>
      {up ? <ArrowUpIcon className="h-3 w-3" /> : <ArrowDownIcon className="h-3 w-3" />}
      {Math.abs(pct)}%
    </span>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-2.5 w-full rounded-full bg-[#F1ECE3]">
      <div className="h-2.5 rounded-full bg-dash-green" style={{ width: `${Math.max(pct, value > 0 ? 1 : 0)}%` }} />
    </div>
  );
}

function Funnel({ label, value, max, note }: { label: string; value: number; max: number; note?: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-dash-ink">{label}</span>
        <span className="tabular-nums text-dash-muted">{n(value)}{note ? ` · ${note}` : ""}</span>
      </div>
      <Bar value={value} max={max} />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="mt-2 text-xs text-dash-muted">{text}</p>;
}
