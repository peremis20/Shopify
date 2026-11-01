"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ProspectList } from "@/lib/analytics/autopilot/backlinks";
import type { RankWatchRow } from "@/lib/analytics/autopilot/tracking";
import type { PageHealth } from "@/lib/analytics/autopilot/health";
import type { AutopilotChange, AutopilotRun } from "@/lib/analytics/autopilot/types";
import type { AutopilotSettingsView } from "@/lib/analytics/autopilot/settings";
import type { OverviewResponse } from "@/lib/analytics/types";
import type { Problem } from "@/lib/analytics/autopilot/inspector";
import { formatNumber } from "./format";
import { api } from "./seo-ui";
import { Card, DeltaBadge, Skeleton } from "./ui";

export type SimplePage = "home" | "keywords" | "content" | "backlinks" | "settings";

interface Authority { ready: boolean; authority: number | null; history?: { day: string; score: number }[] }

/**
 * The Simple view's home screen: three numbers, what the app did this week,
 * and the one thing worth doing next. Everything else is a click away.
 */
export function Home({ data, loading, onGo }: { data: OverviewResponse | null; loading: boolean; onGo: (p: SimplePage) => void }) {
  const [changes, setChanges] = useState<AutopilotChange[] | null>(null);
  const [runs, setRuns] = useState<AutopilotRun[]>([]);
  const [settings, setSettings] = useState<AutopilotSettingsView | null>(null);
  const [ranks, setRanks] = useState<RankWatchRow[] | null>(null);
  const [health, setHealth] = useState<PageHealth[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [authority, setAuthority] = useState<Authority | null>(null);
  const [prospects, setProspects] = useState<ProspectList | null>(null);

  useEffect(() => {
    api<{ changes: AutopilotChange[]; runs: AutopilotRun[]; settings: AutopilotSettingsView }>("/api/autopilot")
      .then((d) => {
        setChanges(d.changes ?? []);
        setRuns(d.runs ?? []);
        setSettings(d.settings ?? null);
      })
      .catch(() => setChanges([]));
    api<{ ranks: RankWatchRow[]; health: PageHealth[] }>("/api/autopilot/watch")
      .then((d) => {
        setRanks(d.ranks ?? []);
        setHealth(d.health ?? []);
      })
      .catch(() => setRanks([]));
    api<{ problems: Problem[] }>("/api/inspector").then((d) => setProblems(d.problems ?? [])).catch(() => setProblems([]));
    api<Authority>("/api/seo/authority").then(setAuthority).catch(() => setAuthority(null));
    api<{ list: ProspectList | null }>("/api/seo/backlinks").then((d) => setProspects(d.list)).catch(() => setProspects(null));
  }, []);

  const gsc = data?.gsc?.data;
  const pageOne = ranks?.filter((r) => r.position !== null && r.position <= 10) ?? [];
  const pageOneBefore = ranks?.filter((r) => r.previous !== null && r.previous <= 10).length ?? 0;
  const hist = authority?.history ?? [];
  const strengthChange = hist.length > 1 && authority?.authority != null ? Math.round((authority.authority - hist[0].score) * 10) / 10 : null;

  // This week, in plain words.
  const since = Date.now() - 7 * 86_400_000;
  const week = (changes ?? []).filter((c) => new Date(c.createdAt).getTime() >= since);
  const live = week.filter((c) => c.status === "applied" || c.status === "kept");
  const pages = new Set(live.filter((c) => !["internal_link", "link_fix", "new_article"].includes(c.field)).map((c) => c.pageUrl)).size;
  const articles = week.filter((c) => c.field === "new_article" && c.status !== "reverted" && c.status !== "skipped");
  const links = live.filter((c) => c.field === "internal_link").length;
  const fixes = (changes ?? []).filter((c) => c.status === "suggested");
  const measured = (changes ?? []).filter((c) => c.baselinePosition !== null && c.resultPosition !== null);
  const up = measured.filter((c) => c.resultPosition! < c.baselinePosition! - 0.5).length;
  const openProspects = prospects?.prospects.filter((p) => p.status === "new") ?? [];

  const done: string[] = [];
  if (pages) done.push(`Improved ${pages} ${pages === 1 ? "page" : "pages"} so they match what people search for`);
  if (articles.length) done.push(`Wrote and posted ${articles.length} new ${articles.length === 1 ? "article" : "articles"}`);
  if (links) done.push(`Added ${links} ${links === 1 ? "link" : "links"} between your pages`);
  if (up) done.push(`${up} ${up === 1 ? "change has" : "changes have"} already moved you up on Google`);
  for (const p of problems.filter((x) => x.who === "repaired")) done.push(`Caught and fixed a problem: ${p.text} ${p.fix}`);
  if (openProspects.length) done.push(`Found ${openProspects.length} ${openProspects.length === 1 ? "website" : "websites"} that could link to you`);

  // One next step, the most useful first.
  const next: { text: string; button: string; page: SimplePage } =
    fixes.length > 0
      ? { text: `${fixes.length} ${fixes.length === 1 ? "change is" : "changes are"} ready for you to paste into your site. Each takes about a minute.`, button: "Open the fix list", page: "content" }
      : openProspects.length > 0
        ? { text: `${openProspects[0].domain} could link to you. The email is written for you, just send it.`, button: "See the email", page: "backlinks" }
        : { text: "Pick an Easy search you'd like to show up for, and the autopilot will go after it first.", button: "Find Easy searches", page: "keywords" };

  const ready = changes !== null && ranks !== null;

  // Warnings: only when something needs attention.
  const warnings: { text: string; page: SimplePage }[] = [];
  const dropped = (ranks ?? []).filter((r) => r.previous !== null && r.previous <= 10 && (r.position === null || r.position > 10));
  if (dropped.length) warnings.push({ text: `${dropped.length === 1 ? `"${dropped[0].query}" dropped` : `${dropped.length} searches dropped`} off Google page 1 since the last check.`, page: "keywords" });
  const broken = health.filter((h) => h.issues.some((i) => i.level === "high"));
  if (broken.length) warnings.push({ text: `${broken.length} ${broken.length === 1 ? "page has" : "pages have"} a serious problem Google can see, like not being indexed.`, page: "content" });
  if (settings && !settings.platformReady) warnings.push({ text: "The autopilot can't run: an AI key or the store connection is missing.", page: "settings" });
  else if (settings && !settings.enabled) warnings.push({ text: "The autopilot is switched off, so nothing is being improved.", page: "content" });
  // What the Inspector found that needs a person (repairs it made itself show under "What I did").
  for (const p of problems.filter((x) => x.who === "owner" || x.who === "watching")) {
    if (warnings.some((w) => w.text.startsWith("The last autopilot run") && p.id === "autopilot:failed")) continue;
    warnings.push({ text: `${p.text} ${p.fix}`, page: p.id.startsWith("service:") ? "settings" : p.id.startsWith("ranks") ? "keywords" : "content" });
  }
  const lastRun = runs[0];
  if (lastRun && /fail|error/i.test(lastRun.status)) warnings.push({ text: `The last autopilot run had a problem: ${lastRun.summary ?? "see Content for details"}.`, page: "content" });

  // Biggest win: the largest climb among tracked searches (off page 1 counts as #25).
  const win = (ranks ?? [])
    // Needs an earlier check, so a search seen for the first time doesn't count as a climb.
    .filter((r) => r.position !== null && (r.previous !== null || (r.history?.length ?? 0) > 1))
    .map((r) => ({ r, gain: (r.previous ?? 25) - r.position! }))
    .filter((x) => x.gain >= 1)
    .sort((a, b) => b.gain - a.gain)[0];

  const sales = data?.ga?.data?.organicSales;
  const salesTracked = sales && (sales.orders.value > 0 || sales.orders.previous > 0 || sales.revenue.value > 0);
  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: sales?.currency || "USD", maximumFractionDigits: 0 }).format(n);

  return (
    <div className="mt-6 space-y-5">
      {warnings.length > 0 && (
        <div className="rounded-2xl border border-dash-down/30 bg-dash-down/5 p-4">
          <p className="mb-2 font-semibold text-dash-down">Needs your attention</p>
          <ul className="space-y-2">
            {warnings.map((w) => (
              <li key={w.text} className="flex flex-wrap items-center justify-between gap-2 text-sm text-dash-ink">
                <span className="min-w-0 flex-1">{w.text}</span>
                <button onClick={() => onGo(w.page)} className="text-xs font-semibold text-dash-green hover:underline">Take a look</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Visitors from Google"
          hint="Clicks to your site from Google search in this period"
          value={loading ? null : gsc ? formatNumber(gsc.totals.clicks.value) : "Not connected"}
          badge={gsc && <DeltaBadge delta={gsc.totals.clicks} />}
        />
        <Stat
          label="Searches on page 1"
          hint="Searches the app checks daily where you show on Google's first page"
          value={ranks === null ? null : String(pageOne.length)}
          badge={ranks && ranks.length > 0 && <Change n={pageOne.length - pageOneBefore} />}
        />
        <Stat
          label="Site strength"
          hint="Open PageRank, 0 to 10. Grows as other sites link to you."
          value={authority === null ? null : authority.authority == null ? "Not scored yet" : `${authority.authority.toFixed(1)} / 10`}
          badge={strengthChange !== null && <Change n={strengthChange} />}
        />
        <Stat
          label="Sales from Google"
          hint="Orders and revenue from people who found you on Google search (from Google Analytics)"
          value={loading ? null : salesTracked ? money(sales!.revenue.value) : "Not tracked yet"}
          badge={
            salesTracked ? (
              <span className="flex items-center gap-2 text-xs text-dash-muted">
                {formatNumber(sales!.orders.value)} {sales!.orders.value === 1 ? "order" : "orders"} <DeltaBadge delta={sales!.revenue} />
              </span>
            ) : (
              <span className="text-xs text-dash-muted">Turn on purchase tracking in Google Analytics to see this.</span>
            )
          }
        />
      </div>

      {win && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-dash-up/30 bg-dash-up/5 p-4">
          <span className="rounded-full bg-dash-up px-2.5 py-0.5 text-xs font-semibold text-white">Biggest win</span>
          <p className="min-w-0 flex-1 text-dash-ink">
            &ldquo;{win.r.query}&rdquo; climbed {win.r.previous === null ? "onto Google page 1" : `from #${win.r.previous}`} to #{win.r.position}.
          </p>
        </div>
      )}

      <Card>
        <p className="mb-3 font-serif text-xl text-dash-ink">Your next step</p>
        {!ready ? (
          <Skeleton className="h-12" />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 text-dash-ink">{next.text}</p>
            <button onClick={() => onGo(next.page)} className="rounded-xl bg-dash-green px-4 py-2.5 text-sm font-semibold text-white hover:bg-dash-deep">
              {next.button}
            </button>
          </div>
        )}
      </Card>

      <Card>
        <p className="mb-3 font-serif text-xl text-dash-ink">What I did this week</p>
        {!ready ? (
          <Skeleton className="h-20" />
        ) : done.length ? (
          <ul className="space-y-2">
            {done.map((d) => (
              <li key={d} className="flex gap-2 text-dash-ink">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-dash-up" />
                {d}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-dash-muted">Nothing yet this week. Turn on the autopilot under Content and it starts working within a day.</p>
        )}
        {articles.length > 0 && (
          <p className="mt-3 text-sm text-dash-muted">Newest article is about &ldquo;{articles[0].query}&rdquo;.</p>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Jump label="Keywords" sub="What to rank for" onClick={() => onGo("keywords")} />
        <Jump label="Content" sub="Changes and articles" onClick={() => onGo("content")} />
        <Jump label="Backlinks" sub="Sites to reach out to" onClick={() => onGo("backlinks")} />
        <Jump label="Settings" sub="Connections and keys" onClick={() => onGo("settings")} />
      </div>
    </div>
  );
}

function Stat({ label, hint, value, badge }: { label: string; hint: string; value: string | null; badge?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dash-line bg-white p-5" title={hint}>
      <p className="text-sm text-dash-muted">{label}</p>
      {value === null ? <Skeleton className="mt-3 h-8 w-24" /> : <p className="mt-2 font-serif text-3xl text-dash-ink tabular-nums">{value}</p>}
      <div className="mt-2 min-h-[1.5rem]">{badge}</div>
    </div>
  );
}

function Change({ n }: { n: number }) {
  if (n === 0) return <span className="text-xs text-dash-muted">No change</span>;
  return <span className={`text-xs font-semibold ${n > 0 ? "text-dash-up" : "text-dash-down"}`}>{n > 0 ? `Up ${n}` : `Down ${Math.abs(n)}`}</span>;
}

function Jump({ label, sub, onClick }: { label: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-2xl border border-dash-line bg-white p-4 text-left hover:border-dash-green/40">
      <p className="font-semibold text-dash-ink">{label}</p>
      <p className="text-xs text-dash-muted">{sub}</p>
    </button>
  );
}
