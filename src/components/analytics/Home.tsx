"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ProspectList } from "@/lib/analytics/autopilot/backlinks";
import type { RankWatchRow } from "@/lib/analytics/autopilot/tracking";
import type { PageHealth } from "@/lib/analytics/autopilot/health";
import type { AutopilotChange, AutopilotRun } from "@/lib/analytics/autopilot/types";
import type { AutopilotSettingsView } from "@/lib/analytics/autopilot/settings";
import type { OverviewResponse } from "@/lib/analytics/types";
import type { Problem } from "@/lib/analytics/autopilot/inspector";
import type { StrategyReport } from "@/lib/analytics/autopilot/strategist";
import { formatNumber } from "./format";
import { api } from "./seo-ui";
import { DeltaBadge, Skeleton } from "./ui";

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
  const [strategy, setStrategy] = useState<StrategyReport | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  async function planNow() {
    setPlanning(true);
    setPlanError(null);
    try {
      const d = await api<{ report: StrategyReport | null; error?: string }>("/api/strategy", { refresh: true });
      setStrategy(d.report);
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

  const gsc = data?.gsc?.data;
  const pageOne = ranks?.filter((r) => r.position !== null && r.position <= 10) ?? [];
  const quoted = ranks?.filter((r) => r.quoted).length ?? 0;
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
    warnings.push({ text: `${p.text} ${p.fix}`, page: p.id.startsWith("service:") ? "settings" : p.id.startsWith("ranks") ? "keywords" : "content" });
  }
  const lastRun = runs[0];
  if (lastRun && /fail|error/i.test(lastRun.status) && !problems.some((p) => p.id === "autopilot:failed")) warnings.push({ text: `The last autopilot run had a problem: ${lastRun.summary ?? "see Content for details"}.`, page: "content" });

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

  const activity = [
    { n: pages, label: pages === 1 ? "page improved" : "pages improved" },
    { n: articles.length, label: articles.length === 1 ? "article posted" : "articles posted" },
    { n: links, label: links === 1 ? "link between your pages" : "links between your pages" },
    { n: openProspects.length, label: openProspects.length === 1 ? "site to ask for a backlink" : "sites to ask for a backlink" },
  ];
  const repaired = problems.filter((x) => x.who === "repaired");
  const wonLinks = prospects?.prospects.filter((p) => p.status === "won").length ?? 0;

  return (
    <div className="mt-5 space-y-4">
      {warnings.length > 0 && (
        <div className="rounded-xl border border-dash-down/25 bg-dash-down/5">
          {warnings.map((w, i) => (
            <div key={w.text} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm ${i ? "border-t border-dash-down/15" : ""}`}>
              <span className="h-2 w-2 shrink-0 rounded-full bg-dash-down" />
              <span className="min-w-0 flex-1 text-dash-ink">
                {i === 0 && <span className="font-semibold text-dash-down">Needs your attention: </span>}
                {w.text}
              </span>
              <button onClick={() => onGo(w.page)} className="text-xs font-semibold text-dash-green hover:underline">Take a look</button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Jump label="Keywords" sub={ranks ? `${ranks.length} tracked, ${pageOne.length} on page 1` : "What to rank for"} onClick={() => onGo("keywords")} />
        <Jump label="Content" sub={fixes.length ? `${fixes.length} ${fixes.length === 1 ? "fix" : "fixes"} ready to paste` : `${pages + articles.length} updates this week`} onClick={() => onGo("content")} />
        <Jump label="Backlinks" sub={`${openProspects.length} ${openProspects.length === 1 ? "site" : "sites"} to reach out to`} onClick={() => onGo("backlinks")} />
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
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
          badge={
            ranks &&
            ranks.length > 0 && (
              <span className="flex flex-wrap items-center gap-x-2">
                <Change n={pageOne.length - pageOneBefore} />
                {quoted > 0 && <span className="text-xs text-dash-up" title="Google shows your page as the quoted answer at the top">{quoted} quoted by Google</span>}
              </span>
            )
          }
        />
        <Stat
          label="Site strength"
          hint="Open PageRank, 0 to 10. Grows as other sites link to you."
          value={authority === null ? null : authority.authority == null ? "Not scored" : `${authority.authority.toFixed(1)}/10`}
          badge={strengthChange !== null && <Change n={strengthChange} />}
        />
        <Stat
          label="Sales from Google"
          hint="Orders and revenue from people who found you on Google search (from Google Analytics). Needs purchase tracking in Google Analytics."
          value={loading ? null : salesTracked ? money(sales!.revenue.value) : "Not tracked"}
          badge={
            salesTracked ? (
              <span className="flex items-center gap-2 text-xs text-dash-muted">
                {formatNumber(sales!.orders.value)} {sales!.orders.value === 1 ? "order" : "orders"} <DeltaBadge delta={sales!.revenue} />
              </span>
            ) : (
              <span className="text-xs text-dash-muted">Needs GA purchase tracking</span>
            )
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Plan strategy={strategy} visitors={gsc ? gsc.totals.clicks.value : null} currency={sales?.currency ?? null} planning={planning} error={planError} onPlan={planNow} />
        </div>

        <div className="space-y-4">
          <Panel title="Your next step">
            {!ready ? (
              <Skeleton className="h-16" />
            ) : (
              <>
                <p className="text-sm text-dash-ink">{next.text}</p>
                <button onClick={() => onGo(next.page)} className="mt-3 w-full rounded-lg bg-dash-green px-3 py-2 text-sm font-semibold text-white hover:bg-dash-deep">
                  {next.button}
                </button>
              </>
            )}
          </Panel>

          {win && (
            <div className="rounded-xl border border-dash-up/30 bg-dash-up/5 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-dash-up">Biggest win</p>
              <p className="mt-1 text-sm text-dash-ink">
                &ldquo;{win.r.query}&rdquo; climbed {win.r.previous === null ? "onto page 1" : `from #${win.r.previous}`} to #{win.r.position}.
              </p>
            </div>
          )}

          <Panel title="This week">
            {!ready ? (
              <Skeleton className="h-20" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-dash-line bg-dash-line">
                  {activity.map((a) => (
                    <div key={a.label} className="bg-white px-3 py-2.5">
                      <p className="font-serif text-xl leading-none text-dash-ink tabular-nums">{a.n}</p>
                      <p className="mt-1 text-xs text-dash-muted">{a.label}</p>
                    </div>
                  ))}
                </div>
                {wonLinks > 0 && <p className="mt-2 text-xs text-dash-up">{wonLinks} {wonLinks === 1 ? "backlink" : "backlinks"} won so far.</p>}
                {up > 0 && <p className="mt-2 text-xs text-dash-up">{up} {up === 1 ? "change has" : "changes have"} already moved you up on Google.</p>}
                {repaired.map((p) => (
                  <p key={p.id} className="mt-2 text-xs text-dash-muted">Fixed on its own: {p.text}</p>
                ))}
                {articles.length > 0 && <p className="mt-2 truncate text-xs text-dash-muted" title={articles[0].query}>Newest article: &ldquo;{articles[0].query}&rdquo;</p>}
                {!activity.some((a) => a.n > 0) && <p className="mt-2 text-xs text-dash-muted">Nothing yet this week. Turn on the autopilot under Content.</p>}
              </>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, hint, value, badge }: { label: string; hint: string; value: string | null; badge?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dash-line bg-white px-4 py-3" title={hint}>
      <p className="text-xs font-medium text-dash-muted">{label}</p>
      {value === null ? <Skeleton className="mt-2 h-7 w-20" /> : <p className="mt-1 font-serif text-2xl text-dash-ink tabular-nums">{value}</p>}
      <div className="mt-1 min-h-[1.25rem] text-sm">{badge}</div>
    </div>
  );
}

/** A shortcut to one of the main areas, with a live count. */
function Jump({ label, sub, onClick }: { label: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group flex items-center justify-between gap-2 rounded-xl border border-dash-line bg-white px-4 py-2.5 text-left hover:border-dash-green/50">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-dash-ink">{label}</span>
        <span className="hidden truncate text-xs text-dash-muted sm:block">{sub}</span>
      </span>
      <span className="text-dash-muted group-hover:text-dash-green" aria-hidden>&rsaquo;</span>
    </button>
  );
}

/** A compact titled box for the home screen. */
function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-dash-line bg-white px-4 py-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-dash-muted">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Change({ n }: { n: number }) {
  if (n === 0) return <span className="text-xs text-dash-muted">No change</span>;
  return <span className={`text-xs font-semibold ${n > 0 ? "text-dash-up" : "text-dash-down"}`}>{n > 0 ? `Up ${n}` : `Down ${Math.abs(n)}`}</span>;
}


/** The Strategist's week: progress to the goal, the moves that survived review, and the ones that didn't. */
function Plan({ strategy, visitors, currency, planning, error, onPlan }: {
  strategy: StrategyReport | null;
  visitors: number | null;
  currency: string | null;
  planning: boolean;
  error: string | null;
  onPlan: () => void;
}) {
  const [showDropped, setShowDropped] = useState(false);
  const goal = strategy?.goal ?? 20_000;
  const now = visitors ?? strategy?.visitors ?? null;
  const pct = now !== null ? Math.min(100, (now / goal) * 100) : 0;
  const kept = strategy?.moves.filter((m) => m.kept) ?? [];
  const dropped = strategy?.moves.filter((m) => !m.kept) ?? [];
  return (
    <Panel
      title="This week's plan"
      right={strategy && <span className="text-[11px] text-dash-muted">Planned {new Date(strategy.at).toLocaleDateString()} · checked by a second AI</span>}
    >
      <div className="mb-3">
        <div className="mb-1 flex justify-between text-xs text-dash-muted">
          <span>Goal: {formatNumber(goal)} visitors a month from Google</span>
          <span className="tabular-nums">{now !== null ? `${formatNumber(now)} now (${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%)` : "not measured yet"}</span>
        </div>
        {strategy?.revenue != null && strategy.revenue > 0 && (
          <p className="mb-1 text-xs text-dash-muted">Sales from Google, last 28 days:{" "}
            <span className="font-semibold text-dash-ink">
              {currency
                ? new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(strategy.revenue)
                : formatNumber(Math.round(strategy.revenue))}
            </span></p>
        )}
        <div className="h-2 overflow-hidden rounded-full bg-[#F1ECE3]">
          <div className="h-full rounded-full bg-dash-green" style={{ width: `${Math.max(pct, now ? 1 : 0)}%` }} />
        </div>
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
          <p className="text-sm leading-relaxed text-dash-ink">{strategy.assessment}</p>
          {kept.length > 0 && (
            <ol className="mt-3 space-y-2">
              {kept.map((m, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-dash-green text-xs font-semibold text-white">{i + 1}</span>
                  <div className="min-w-0">
                    <p className="text-dash-ink">{m.action}</p>
                    <p className="text-xs text-dash-muted">{m.why}{m.done ? ` ${m.done}` : ""}</p>
                  </div>
                </li>
              ))}
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
      {error && <p className="mt-2 text-xs text-dash-down">{error}</p>}
    </Panel>
  );
}
