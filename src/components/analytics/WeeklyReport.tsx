"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { WeeklyReportData } from "@/lib/analytics/autopilot/alerts";
import { DonutChart } from "./DonutChart";
import { ArrowDownIcon, ArrowUpIcon } from "./Icons";
import { api } from "./seo-ui";
import { Card, CardHeader, Skeleton } from "./ui";

const n = (v: number) => Math.round(v).toLocaleString("en-US");

/** This week's report as charts and cards, from the site's own data. The weekly email sends the same numbers. */
export function WeeklyReport({ auto = false }: { auto?: boolean }) {
  const [data, setData] = useState<WeeklyReportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function load() {
    setBusy(true);
    setErr(null);
    try {
      setData((await api<{ data: WeeklyReportData }>("/api/autopilot/weekly-report")).data);
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
          <button onClick={load} className="rounded-full bg-dash-green px-3 py-1 text-xs font-semibold text-white">See this week&apos;s report</button>
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

  return (
    <div className="mt-6 space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-dash-muted">Last 7 days, from your own Google data. The weekly email sends the same.</p>
        <button onClick={load} disabled={busy} className="text-xs font-semibold text-dash-green hover:underline disabled:opacity-50">{busy ? "Updating..." : "Update"}</button>
      </div>

      {/* Headline cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Visits" value={traffic.length ? n(visits) : "None"} sub="all channels" />
        <Stat label="From Google" value={google ? n(google.now.sessions) : "None"} change={google ? [google.now.sessions, google.before.sessions] : undefined} />
        <Stat label="Leads and sales" value={n(leads)} sub={sales > 0 ? `${n(sales)} in sales` : "key events"} />
        <Stat label="Work done" value={n(data.week.changes + data.week.articles + data.week.links)} sub={`${data.week.changes} changes, ${data.week.articles} ${data.week.articles === 1 ? "article" : "articles"}, ${data.week.links} ${data.week.links === 1 ? "link" : "links"}`} />
      </div>

      {/* Goal */}
      {data.visitors && (
        <Card>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-semibold text-dash-ink">Goal: {n(data.visitors.goal)} Google visitors a month</span>
            <span className="tabular-nums text-dash-muted">{n(data.visitors.value)} now</span>
          </div>
          <Bar value={data.visitors.value} max={data.visitors.goal} />
          {data.focus && <p className="mt-3 text-sm text-dash-ink">{data.focus}</p>}
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Channels */}
        <Card>
          <CardHeader title="Where visits came from" />
          {data.traffic === "none" ? (
            <p className="text-sm text-dash-muted">Connect Google Analytics in Settings.</p>
          ) : data.traffic === "error" ? (
            <p className="text-sm text-dash-muted">Google Analytics couldn&apos;t be read. Left out, not guessed.</p>
          ) : traffic.length === 0 ? (
            <p className="text-sm text-dash-muted">No visits recorded.</p>
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
          {data.backlinks ? (
            <div className="space-y-3">
              <Funnel label="Sites found" value={data.backlinks.found} max={data.backlinks.found} />
              <Funnel label="Emails ready" value={data.backlinks.ready} max={data.backlinks.found} />
              <Funnel label="Emailed" value={data.backlinks.emailed} max={data.backlinks.found} />
              <Funnel label="Links won" value={data.backlinks.wonAll} max={data.backlinks.found} note={data.backlinks.wonWeek ? `${data.backlinks.wonWeek} this week` : undefined} />
              {data.backlinks.fromLinks.length > 0 && (
                <p className="text-xs text-dash-muted">Visits from your links: {data.backlinks.fromLinks.map((x) => `${x.domain} ${x.visits}`).join(", ")}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-dash-muted">No sites found yet.</p>
          )}
        </Card>
      </div>

      {/* Plan */}
      {data.plan.length > 0 && (
        <Card>
          <CardHeader title="This week's plan" />
          <ol className="space-y-1.5">
            {data.plan.map((m, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-dash-green text-xs font-semibold text-white">{i + 1}</span>
                <span className="min-w-0 text-dash-ink">{m}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {/* Agents */}
      {data.agents.length > 0 && (
        <Card>
          <CardHeader title="What each agent did" />
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
      )}

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
