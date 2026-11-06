"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ProspectList } from "@/lib/analytics/autopilot/backlinks";
import type { RankWatchRow } from "@/lib/analytics/autopilot/tracking";
import type { PageHealth } from "@/lib/analytics/autopilot/health";
import type { AutopilotChange, AutopilotRun } from "@/lib/analytics/autopilot/types";
import type { AutopilotSettingsView } from "@/lib/analytics/autopilot/settings";
import type { OverviewResponse } from "@/lib/analytics/types";
import { goToGoogle } from "./Onboarding";
import type { Problem } from "@/lib/analytics/autopilot/inspector";
import type { StrategyReport } from "@/lib/analytics/autopilot/strategist";
import { formatNumber } from "./format";
import { api } from "./seo-ui";
import { DeltaBadge, Skeleton } from "./ui";
import { BarsIcon, BoltIcon, ExternalIcon, FileIcon, SearchIcon } from "./Icons";

export type SimplePage = "home" | "keywords" | "content" | "backlinks" | "report" | "settings";

interface Authority { ready: boolean; authority: number | null; history?: { day: string; score: number }[] }

/**
 * The Simple view's home screen: three numbers, what the app did this week,
 * and the one thing worth doing next. Everything else is a click away.
 */
export function Home({ data, loading, onGo }: {
  data: OverviewResponse | null;
  loading: boolean;
  onGo: (p: SimplePage) => void;
}) {
  const [changes, setChanges] = useState<AutopilotChange[] | null>(null);
  const [runs, setRuns] = useState<AutopilotRun[]>([]);
  const [settings, setSettings] = useState<AutopilotSettingsView | null>(null);
  const [ranks, setRanks] = useState<RankWatchRow[] | null>(null);
  const [health, setHealth] = useState<PageHealth[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [strategy, setStrategy] = useState<StrategyReport | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planNote, setPlanNote] = useState<string | null>(null);
  async function planNow() {
    setPlanning(true);
    setPlanError(null);
    setPlanNote(null);
    try {
      const d = await api<{ report: StrategyReport | null; error?: string; message?: string }>("/api/strategy", { refresh: true });
      setStrategy(d.report);
      // No plan back: say why (the server's own words when it gives them), never nothing.
      if (!d.report) {
        if (d.error) setPlanError(d.error);
        else setPlanNote(d.message || "No plan yet. The Strategist needs a little more data from your site first. Please try again later.");
      }
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : "Couldn't plan right now");
    } finally {
      setPlanning(false);
    }
  }
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
    api<{ report: StrategyReport | null }>("/api/strategy").then((d) => setStrategy(d.report)).catch(() => setStrategy(null));
    api<{ problems: Problem[] }>("/api/inspector").then((d) => setProblems(d.problems ?? [])).catch(() => setProblems([]));
    api<Authority>("/api/seo/authority").then(setAuthority).catch(() => setAuthority(null));
    api<{ list: ProspectList | null }>("/api/seo/backlinks").then((d) => setProspects(d.list)).catch(() => setProspects(null));
  }, []);

  // Only live numbers: a customer's own numbers are never made up.
  const gsc = data?.gsc?.status === "live" ? data.gsc.data : undefined;
  const admin = data?.account?.admin ?? false;
  // The goal is a month of visitors, so compare it with 28 days, not whatever range is picked.
  const days = data?.gsc?.range ? Math.round((Date.parse(data.gsc.range.end) - Date.parse(data.gsc.range.start)) / 86_400_000) + 1 : null;
  const monthly: { value: number; note: string } | null =
    gsc && days === 28
      ? { value: gsc.totals.clicks.value, note: "in the last 28 days" }
      : strategy?.visitors != null
        ? { value: strategy.visitors, note: "in the last 28 days" }
        : gsc && days && days > 0
          ? { value: Math.round((gsc.totals.clicks.value * 28) / days), note: `a month at the pace of the last ${days} days` }
          : null;
  const pageOne = ranks?.filter((r) => r.position !== null && r.position <= 10) ?? [];
  const quoted = ranks?.filter((r) => r.quoted).length ?? 0;
  const pageOneBefore = ranks?.filter((r) => r.previous !== null && r.previous <= 10).length ?? 0;
  const hist = authority?.history ?? [];
  const strengthChange = hist.length > 1 && authority?.authority != null ? Math.round((authority.authority - hist[0].score) * 10) / 10 : null;

  // This week, in plain words.
  const since = Date.now() - 7 * 86_400_000;
  const week = (changes ?? []).filter((c) => new Date(c.createdAt).getTime() >= since);
  const live = week.filter((c) => c.status === "applied" || c.status === "kept");
  const pages = new Set(live.filter((c) => !["internal_link", "link_fix", "new_article", "prune"].includes(c.field)).map((c) => c.pageUrl)).size;
  const articles = week.filter((c) => c.field === "new_article" && c.status !== "reverted" && c.status !== "skipped");
  const links = live.filter((c) => c.field === "internal_link").length;
  const fixes = (changes ?? []).filter((c) => c.status === "suggested");
  const measured = (changes ?? []).filter((c) => c.baselinePosition !== null && c.resultPosition !== null);
  const up = measured.filter((c) => c.resultPosition! < c.baselinePosition! - 0.5).length;
  const openProspects = prospects?.prospects.filter((p) => p.status === "new") ?? [];

  // One next step, the most useful first.
  const next: { text: string; button: string; page: SimplePage } =
    fixes.length > 0
      ? { text: `${fixes.length} ${fixes.length === 1 ? "change is" : "changes are"} ready for you to paste into your site. Each takes about a minute.`, button: "Open the fix list", page: "content" }
      : openProspects.length > 0
        ? { text: `${openProspects[0].domain} could link to you. The email is written for you, just send it.`, button: "See the email", page: "backlinks" }
        : { text: "Pick an Easy search you'd like to show up for, and the autopilot will go after it first.", button: "Find Easy searches", page: "keywords" };

  const ready = changes !== null && ranks !== null;

  // Warnings: only when something needs attention.
  const warnings: { text: string; page: SimplePage; allowGoogle?: boolean; app?: boolean }[] = [];
  const dropped = (ranks ?? []).filter((r) => r.previous !== null && r.previous <= 10 && (r.position === null || r.position > 10));
  if (dropped.length) warnings.push({ text: `${dropped.length === 1 ? `"${dropped[0].query}" dropped` : `${dropped.length} searches dropped`} off Google page 1 since the last check.`, page: "keywords" });
  const broken = health.filter((h) => h.issues.some((i) => i.level === "high"));
  if (broken.length) warnings.push({ text: `${broken.length} ${broken.length === 1 ? "page has" : "pages have"} a serious problem Google can see, like not being indexed.`, page: "keywords" });
  // Only the platform owner can add the platform keys; customers are just told it's being set up.
  if (settings && !settings.platformReady && admin) warnings.push({ text: "The autopilot can't run: a platform key (an AI key or the Shopify app keys) is missing. Add it on the Content page.", page: "content", app: true });
  else if (settings && !settings.platformReady) {
    /* shown below as a calm note, not a warning: there's nothing the owner can do */
  } else if (settings && !settings.enabled) warnings.push({ text: "The autopilot is switched off, so nothing is being improved.", page: "content" });
  // What the Inspector found that needs a person (repairs it made itself show under "What I did").
  for (const p of problems.filter((x) => x.who === "owner" || x.who === "watching")) {
    warnings.push({
      text: `${p.text} ${p.fix}`,
      page: p.id.startsWith("service:") ? "settings" : p.id.startsWith("ranks") || p.id === "google:recrawl" ? "keywords" : "content",
      allowGoogle: p.id === "google:recrawl",
    });
  }
  const lastRun = runs[0];
  if (admin && lastRun && /fail|error/i.test(lastRun.status) && !problems.some((p) => p.id === "autopilot:failed")) warnings.push({ text: `The last autopilot run had a problem: ${lastRun.summary ?? "see Content for details"}.`, page: "content" });

  // Biggest win: the largest climb among tracked searches, between two real positions (never a made up one).
  const win = (ranks ?? [])
    .filter((r) => r.position !== null && r.previous !== null)
    .map((r) => ({ r, gain: r.previous! - r.position! }))
    .filter((x) => x.gain >= 1)
    .sort((a, b) => b.gain - a.gain)[0];

  const sales = data?.ga?.status === "live" ? data.ga.data?.organicSales : undefined;
  const salesTracked = sales && (sales.orders.value > 0 || sales.orders.previous > 0 || sales.revenue.value > 0);
  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: sales?.currency || "USD", maximumFractionDigits: 0 }).format(n);

  const activity = [
    { n: pages, label: pages === 1 ? "page improved" : "pages improved" },
    { n: articles.length, label: articles.length === 1 ? "article posted" : "articles posted" },
    { n: links, label: links === 1 ? "link between your pages" : "links between your pages" },
    { n: openProspects.length, label: openProspects.length === 1 ? "site to ask for a backlink" : "sites to ask for a backlink" },
  ];
  const repaired = problems.filter((x) => x.who === "repaired");
  const wonLinks = prospects?.prospects.filter((p) => p.status === "won").length ?? 0;

  // App and service problems (keys, AI) are amber; problems with the site itself are red.
  const isApp = (w: { page: SimplePage; app?: boolean }) => w.page === "settings" || Boolean(w.app);
  const dailyClicks = gsc?.daily ?? [];
  const newest = articles[0]?.query ?? null;

  return (
    <div className="mt-5 space-y-4">
      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((w, i) => {
            const app = isApp(w);
            return (
              <div
                key={w.text}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3 text-sm shadow-sm ${
                  app ? "border-[#F2C98A] bg-[#FFF6E8]" : "border-[#F3B7B0] bg-[#FDEDEB]"
                }`}
              >
                {app ? <BotIcon className="h-5 w-5 shrink-0 text-[#D9822B]" /> : <AlertIcon className="h-5 w-5 shrink-0 text-dash-down" />}
                <span className="min-w-0 flex-1 text-dash-ink">
                  {(i === 0 || app) && <span className={`font-semibold ${app ? "text-[#C2661B]" : "text-dash-down"}`}>{app ? "App notice: " : "Needs your attention: "}</span>}
                  {w.text}
                </span>
                {w.allowGoogle ? (
                  <button onClick={() => void goToGoogle("recrawl").catch(() => undefined)} className={`text-sm font-semibold hover:underline ${app ? "text-[#C2661B]" : "text-dash-down"}`}>Allow &rarr;</button>
                ) : (
                  <button onClick={() => onGo(w.page)} className={`text-sm font-semibold hover:underline ${app ? "text-[#C2661B]" : "text-dash-down"}`}>Take a look &rarr;</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {settings && !settings.platformReady && !admin && (
        <p className="rounded-xl border border-dash-line bg-white px-4 py-2.5 text-sm text-dash-muted" role="status">
          The autopilot is still being set up on our side. There&apos;s nothing you need to do: it starts on its own as soon as it&apos;s
          ready.
        </p>
      )}

      {/* Headline numbers and the visitors chart */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[repeat(4,minmax(0,1fr))_1.6fr]">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 xl:col-span-4">
          <Stat
            featured
            icon={<GoogleIcon className="h-6 w-6" />}
            label="Visitors from Google"
            hint="Clicks to your site from Google search in this period"
            value={loading ? null : gsc ? formatNumber(gsc.totals.clicks.value) : "Not connected"}
            badge={gsc && <Pill tone={gsc.totals.clicks.change === null ? "neutral" : gsc.totals.clicks.change >= 0 ? "up" : "down"}><DeltaBadge delta={gsc.totals.clicks} /></Pill>}
          />
          <Stat
            icon={<SearchIcon className="h-6 w-6 text-dash-up" />}
            label="Searches on Page 1"
            hint="Searches the app checks daily where you show on Google's first page"
            value={ranks === null ? null : String(pageOne.length)}
            badge={
              ranks &&
              ranks.length > 0 && (
                <span className="flex flex-wrap items-center gap-2">
                  <Pill tone={pageOne.length - pageOneBefore > 0 ? "up" : pageOne.length - pageOneBefore < 0 ? "down" : "neutral"}><Change n={pageOne.length - pageOneBefore} /></Pill>
                  {quoted > 0 && <span className="text-xs text-dash-up">{quoted} quoted by Google</span>}
                </span>
              )
            }
          />
          <Stat
            icon={<BarsIcon className="h-6 w-6 text-dash-up" />}
            label="Site Strength"
            hint="Open PageRank, 0 to 10. Grows as other sites link to you."
            value={authority === null ? null : authority.authority == null ? "Not scored" : `${authority.authority.toFixed(1)} / 10`}
            badge={strengthChange !== null && <Pill tone={strengthChange > 0 ? "up" : strengthChange < 0 ? "down" : "neutral"}><Change n={strengthChange} /></Pill>}
          />
          <Stat
            icon={<CartIcon className="h-6 w-6 text-dash-up" />}
            label="Sales from Google"
            hint="Orders and revenue from people who found you on Google search (from Google Analytics). Needs purchase tracking in Google Analytics."
            value={loading ? null : salesTracked ? money(sales!.revenue.value) : "Not Tracked"}
            badge={
              salesTracked ? (
                <span className="flex flex-wrap items-center gap-2"><Pill tone="neutral">{formatNumber(sales!.orders.value)} {sales!.orders.value === 1 ? "order" : "orders"}</Pill><DeltaBadge delta={sales!.revenue} /></span>
              ) : (
                <Pill tone="neutral">Set up sales tracking</Pill>
              )
            }
          />
        </div>
        <VisitorsChart daily={dailyClicks} total={gsc?.totals.clicks ?? null} loading={loading} />
      </div>

      {/* The main areas */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Jump icon={<SearchIcon className="h-6 w-6" />} label="Keywords" sub={ranks ? `${ranks.length} tracked, ${pageOne.length} on page 1` : "What to rank for"} onClick={() => onGo("keywords")} />
        <Jump icon={<FileIcon className="h-6 w-6" />} label="Content" sub={fixes.length ? `${fixes.length} ${fixes.length === 1 ? "fix" : "fixes"} ready to paste` : `${pages + articles.length} updates this week`} onClick={() => onGo("content")} />
        <Jump icon={<LinkIcon className="h-6 w-6" />} label="Backlinks" sub={`${openProspects.length} ${openProspects.length === 1 ? "site" : "sites"} to reach out to`} onClick={() => onGo("backlinks")} />
        <Jump icon={<BarsIcon className="h-6 w-6" />} label="Report" sub="This week's results" onClick={() => onGo("report")} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Plan strategy={strategy} monthly={monthly} currency={sales?.currency ?? null} planning={planning} error={planError} note={planNote} onPlan={planNow} onGo={onGo} />
        </div>

        <div className="space-y-4">
          <section className="relative overflow-hidden rounded-2xl border border-[#BFE3C4] bg-gradient-to-br from-[#F1FAF1] to-[#DDF3DF] px-5 py-4 shadow-sm">
            <h3 className="flex items-center gap-2 text-lg font-semibold text-dash-ink">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#2FA84F] text-white"><BoltIcon className="h-4 w-4" /></span>
              Your Next Step
            </h3>
            {!ready ? (
              <Skeleton className="mt-3 h-16" />
            ) : (
              <div className="mt-2 flex items-end gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-dash-ink">{next.text}</p>
                  <button onClick={() => onGo(next.page)} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-[#1E7A3C] px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-dash-deep">
                    <SendIcon className="h-4 w-4" />
                    {next.button}
                  </button>
                </div>
                <MailArt className="hidden h-20 w-20 shrink-0 sm:block" />
              </div>
            )}
          </section>

          {win && (
            <div className="rounded-2xl border border-dash-up/30 bg-dash-up/5 px-5 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-dash-up">Biggest win</p>
              <p className="mt-1 text-sm text-dash-ink">
                &ldquo;{win.r.query}&rdquo; climbed {win.r.previous === null ? "onto page 1" : `from #${win.r.previous}`} to #{win.r.position}.
              </p>
            </div>
          )}

          <section className="rounded-2xl border border-dash-line bg-white px-5 py-4 shadow-sm">
            <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-dash-ink">
              <BarsIcon className="h-5 w-5 text-dash-up" />
              This Week at a Glance
            </h3>
            {!ready ? (
              <Skeleton className="h-28" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {activity.map((a, i) => (
                    <div key={a.label} className="flex items-start gap-2 rounded-xl border border-dash-line bg-[#FBFDF9] px-3 py-2.5">
                      <span className="mt-0.5 text-dash-up">{[<FileIcon key="f" className="h-5 w-5" />, <PenIcon key="p" className="h-5 w-5" />, <LinkIcon key="l" className="h-5 w-5" />, <ExternalIcon key="e" className="h-5 w-5" />][i]}</span>
                      <span className="min-w-0">
                        <span className="block text-xl font-semibold leading-none text-dash-ink tabular-nums">{a.n}</span>
                        <span className="mt-1 block text-xs text-dash-muted">{a.label}</span>
                      </span>
                    </div>
                  ))}
                </div>
                {newest && (
                  <p className="mt-2 flex items-center gap-2 truncate rounded-xl bg-[#F4F8F1] px-3 py-2 text-xs text-dash-ink" title={newest}>
                    <FileIcon className="h-4 w-4 shrink-0 text-dash-up" /> Newest article: &ldquo;{newest}&rdquo;
                  </p>
                )}
                {wonLinks > 0 && <p className="mt-2 text-xs text-dash-up">{wonLinks} {wonLinks === 1 ? "backlink" : "backlinks"} won so far.</p>}
                {up > 0 && <p className="mt-2 text-xs text-dash-up">{up} {up === 1 ? "change has" : "changes have"} already moved you up on Google.</p>}
                {repaired.map((p) => (
                  <p key={p.id} className="mt-2 text-xs text-dash-muted">Fixed on its own: {p.text}</p>
                ))}
                {!activity.some((a) => a.n > 0) && (
                  <p className="mt-2 text-xs text-dash-muted">
                    Nothing yet this week.
                    {settings?.platformReady && (settings.enabled ? " The autopilot is on; its changes show here as it makes them." : " Turn on the autopilot under Content.")}
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Pill({ tone, children }: { tone: "up" | "down" | "neutral"; children: ReactNode }) {
  const cls = tone === "up" ? "bg-dash-up/10 text-dash-up" : tone === "down" ? "bg-dash-down/10 text-dash-down" : "bg-[#F1EFEA] text-dash-muted";
  return <span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-semibold ${cls}`}>{children}</span>;
}

function Stat({ label, hint, value, badge, icon, featured }: { label: string; hint: string; value: string | null; badge?: ReactNode; icon: ReactNode; featured?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border px-4 py-4 shadow-sm ${featured ? "border-[#BFE3C4] bg-gradient-to-br from-white via-[#F3FBF2] to-[#D6F0D6]" : "border-dash-line bg-white"}`}
      title={hint}
    >
      <p className="flex items-center gap-2 text-[13px] font-medium leading-tight text-dash-ink">
        <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5">{icon}</span>
        <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`What is ${label}?`}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-dash-line text-[10px] leading-none text-dash-muted hover:border-dash-green hover:text-dash-green"
        >
          ?
        </button>
      </p>
      {open && <p className="mt-1 text-xs text-dash-muted">{hint}</p>}
      {value === null ? <Skeleton className="mt-3 h-8 w-20" /> : <p className="mt-2 text-3xl font-bold tracking-tight text-dash-ink tabular-nums">{value}</p>}
      <div className="mt-2 min-h-[1.75rem] text-sm">{badge}</div>
    </div>
  );
}

/** Daily visitors from Google over the chosen period, from Search Console. */
function VisitorsChart({ daily, total, loading }: { daily: { date: string; clicks: number }[]; total: { value: number; change: number | null } | null; loading: boolean }) {
  const w = 320;
  const h = 110;
  const max = Math.max(1, ...daily.map((d) => d.clicks));
  const pts = daily.map((d, i) => [daily.length > 1 ? (i / (daily.length - 1)) * w : 0, h - (d.clicks / max) * (h - 10) - 4] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = pts.length ? `${line} L${w},${h} L0,${h} Z` : "";
  const label = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const ticks = daily.length > 1 ? [0, Math.floor((daily.length - 1) / 2), daily.length - 1] : [];
  return (
    <section className="rounded-2xl border border-dash-line bg-white px-4 py-4 shadow-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-dash-ink">Google Visitors <span className="font-normal text-dash-muted">(this period)</span></p>
        {total && (
          <span className={`rounded-lg px-2.5 py-1 text-right text-sm font-bold tabular-nums ${total.change !== null && total.change < 0 ? "bg-dash-down/10 text-dash-down" : "bg-dash-up/10 text-dash-up"}`}>
            {formatNumber(total.value)}
            {total.change !== null && <span className="block text-xs font-semibold">{total.change >= 0 ? "▲" : "▼"} {Math.abs(total.change).toFixed(1)}%</span>}
          </span>
        )}
      </div>
      {loading && !daily.length ? (
        <Skeleton className="h-28" />
      ) : daily.length < 2 ? (
        <p className="py-8 text-center text-sm text-dash-muted">{total ? "Not enough days yet for a chart." : "Connect Search Console to see daily visitors."}</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${w} ${h}`} className="h-28 w-full" preserveAspectRatio="none" role="img" aria-label="Daily visitors from Google">
            <defs>
              <linearGradient id="dp-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#2FA84F" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#2FA84F" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <path d={area} fill="url(#dp-area)" />
            <path d={line} fill="none" stroke="#2FA84F" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
          <div className="mt-1 flex justify-between text-[11px] text-dash-muted">
            {ticks.map((t) => <span key={t}>{label(daily[t].date)}</span>)}
          </div>
        </>
      )}
    </section>
  );
}

/** A shortcut to one of the main areas, with a live count. */
function Jump({ label, sub, onClick, icon }: { label: string; sub: string; onClick: () => void; icon: ReactNode }) {
  return (
    <button onClick={onClick} className="group flex items-center gap-3 rounded-2xl border border-dash-line bg-white px-4 py-3 text-left shadow-sm transition hover:border-[#2FA84F]/60 hover:shadow">
      <span className="text-dash-up">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold text-dash-ink">{label}</span>
        <span className="block truncate text-xs text-dash-muted">{sub}</span>
      </span>
      <span className="text-xl text-dash-muted group-hover:text-dash-green" aria-hidden>&rsaquo;</span>
    </button>
  );
}

function Change({ n }: { n: number }) {
  if (n === 0) return <span>No change</span>;
  return <span>{n > 0 ? `Up ${n}` : `Down ${Math.abs(n)}`}</span>;
}

// ---------- icons for the home screen ----------

type P = { className?: string };
function GoogleIcon({ className }: P) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
const Svg = ({ className, children }: P & { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{children}</svg>
);
const CartIcon = (p: P) => <Svg {...p}><circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" /><path d="M2 3h3l2.5 12h11L21 7H6" /></Svg>;
const LinkIcon = (p: P) => <Svg {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Svg>;
const PenIcon = (p: P) => <Svg {...p}><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="m13.5 6.5 4 4" /></Svg>;
const AlertIcon = (p: P) => <Svg {...p}><path d="M12 3 2 21h20L12 3z" /><path d="M12 10v5M12 18h.01" /></Svg>;
const BotIcon = (p: P) => <Svg {...p}><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5" /></Svg>;
const SendIcon = (p: P) => <Svg {...p}><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" /></Svg>;
const TargetIcon = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" /></Svg>;
function MailArt({ className }: P) {
  return (
    <svg viewBox="0 0 80 80" className={className} aria-hidden="true">
      <path d="M62 10l4-6M68 18l7-2M56 8l-1-7" stroke="#F5B400" strokeWidth="3" strokeLinecap="round" />
      <rect x="18" y="14" width="40" height="34" rx="3" fill="#fff" stroke="#E3E3E3" />
      <path d="M24 24h28M24 31h28M24 38h18" stroke="#C9D3DB" strokeWidth="3" strokeLinecap="round" />
      <path d="M8 36l32 22 32-22v34a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V36z" fill="#F7B733" />
      <path d="M8 36l32 22 32-22" fill="none" stroke="#E79A12" strokeWidth="2" />
    </svg>
  );
}


/** Where each kind of planned move is worked on, so the owner can see it happening. */
const MOVE_PAGE: Record<string, { page: SimplePage; label: string }> = {
  target: { page: "keywords", label: "See keyword" },
  cluster: { page: "content", label: "See articles" },
  fix: { page: "content", label: "See fix" },
  asset: { page: "backlinks", label: "See backlinks" },
};

/** The Strategist's week: progress to the goal, the moves that survived review, and the ones that didn't. */
function Plan({ strategy, monthly, currency, planning, error, note, onPlan, onGo }: {
  strategy: StrategyReport | null;
  /** Visitors from Google over 28 days (or scaled to 28 days, and labeled so). */
  monthly: { value: number; note: string } | null;
  currency: string | null;
  planning: boolean;
  error: string | null;
  note: string | null;
  onPlan: () => void;
  onGo: (p: SimplePage) => void;
}) {
  const [showDropped, setShowDropped] = useState(false);
  const goal = strategy?.goal ?? 20_000;
  const now = monthly?.value ?? null;
  const pct = now !== null ? Math.min(100, (now / goal) * 100) : 0;
  const kept = strategy?.moves.filter((m) => m.kept) ?? [];
  const dropped = strategy?.moves.filter((m) => !m.kept) ?? [];
  // The first sentence stands out; the rest is the detail.
  const [lead, ...rest] = (strategy?.assessment ?? "").split(/(?<=\.)\s+/);
  return (
    <section className="rounded-2xl border border-dash-line bg-white px-5 py-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xl font-semibold text-dash-ink">
          <TargetIcon className="h-7 w-7 text-[#2FA84F]" />
          This Week&apos;s Plan
        </h3>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#BFE3C4] bg-[#F1FAF1] px-3 py-1 text-sm text-dash-ink">
          <TargetIcon className="h-4 w-4 text-[#2FA84F]" /> Goal: {formatNumber(goal)} visitors/month
        </span>
      </div>
      <div className="mb-1 flex flex-wrap justify-between gap-2 text-sm">
        <span className="font-semibold text-dash-ink">
          {now !== null ? `${formatNumber(now)} of ${formatNumber(goal)} visitors ${monthly!.note} (${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%)` : "Not measured yet"}
        </span>
        {strategy && <span className="text-xs text-dash-muted">Planned {new Date(strategy.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · Checked by a second AI</span>}
      </div>
      {strategy?.revenue != null && strategy.revenue > 0 && (
        <p className="mb-1 text-xs text-dash-muted">Sales from Google, last 28 days:{" "}
          <span className="font-semibold text-dash-ink">
            {currency
              ? new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(strategy.revenue)
              : formatNumber(Math.round(strategy.revenue))}
          </span></p>
      )}
      <div
        className="mb-4 h-2.5 overflow-hidden rounded-full bg-[#ECEFE9]"
        role="progressbar"
        aria-label="Progress to the monthly visitor goal"
        aria-valuemin={0}
        aria-valuemax={goal}
        aria-valuenow={now !== null ? Math.min(now, goal) : undefined}
        aria-valuetext={now !== null ? `${formatNumber(now)} of ${formatNumber(goal)} visitors` : "Not measured yet"}
      >
        <div className="h-full rounded-full bg-[#2FA84F]" style={{ width: `${Math.max(pct, now ? 1.5 : 0)}%` }} />
      </div>
      {!strategy ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-sm text-dash-muted">The Strategist plans each week from your real numbers. The first plan comes within a day.</p>
          <button onClick={onPlan} disabled={planning} className="rounded-xl border border-dash-line px-4 py-2 text-sm font-semibold text-dash-green disabled:opacity-50">
            {planning ? "Planning..." : "Plan now"}
          </button>
        </div>
      ) : (
        <>
          <div className="flex gap-3 rounded-xl border border-dash-line/70 px-3 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#EAF6EA] text-[#2FA84F]"><SearchIcon className="h-5 w-5" /></span>
            <div className="min-w-0 text-sm">
              <p className="font-semibold text-dash-ink">{lead}</p>
              {rest.length > 0 && <p className="mt-0.5 text-dash-muted">{rest.join(" ")}</p>}
            </div>
          </div>
          {kept.length > 0 && (
            <ol className="mt-3 space-y-2">
              {kept.map((m, i) => {
                const go = MOVE_PAGE[m.kind];
                return (
                  <li key={i} className="flex items-center gap-3 rounded-xl border border-dash-line/70 px-3 py-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1E5B36] text-sm font-semibold text-white">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-dash-ink">{m.action}</p>
                      <p className="text-xs text-dash-muted">{m.why}{m.done ? ` ${m.done}` : ""}</p>
                      {m.evidence && <p className="text-[11px] text-dash-muted">Based on: {m.evidence}</p>}
                    </div>
                    {m.kind === "hold" ? (
                      <span className="shrink-0 rounded-lg border border-dash-line px-3 py-1.5 text-xs font-semibold text-dash-muted">Hold</span>
                    ) : go ? (
                      <button onClick={() => onGo(go.page)} className="shrink-0 rounded-lg border border-[#BFE3C4] bg-[#F4FBF3] px-3 py-1.5 text-xs font-semibold text-[#1E7A3C] hover:bg-[#E6F6E6]">
                        {go.label}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
          {dropped.length > 0 && (
            <div className="mt-3">
              <button onClick={() => setShowDropped((v) => !v)} className="text-xs font-semibold text-dash-muted hover:underline">
                {showDropped ? "Hide" : "Show"} {dropped.length} {dropped.length === 1 ? "idea" : "ideas"} the reviewer turned down
              </button>
              {showDropped && (
                <ul className="mt-2 space-y-1.5">
                  {dropped.map((m, i) => (
                    <li key={i} className="text-xs text-dash-muted">
                      <span className="line-through">{m.action}</span> <span className="text-dash-ink">{m.challenge}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
      {error && <p className="mt-2 text-xs text-dash-down" role="alert">{error}</p>}
      {note && !error && <p className="mt-2 text-xs text-dash-muted" role="status">{note}</p>}
    </section>
  );
}
