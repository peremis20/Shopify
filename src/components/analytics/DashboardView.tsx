"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RANGE_OPTIONS } from "@/lib/analytics/dates";
import type { IntegrationInfo, OverviewResponse, RangeKey } from "@/lib/analytics/types";
import { DonutChart } from "./DonutChart";
import { formatDuration, formatNumber, formatPct, formatRange } from "./format";
import { ClockIcon, CloseIcon, FileIcon, InfoIcon, KeyIcon, MenuIcon, PlusIcon, RefreshIcon, SearchIcon, UsersIcon } from "./Icons";
import { Legend, LineChart } from "./LineChart";
import { KeywordResearch } from "./KeywordResearch";
import { ConnectButton, SettingsPanel, SetupSteps } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";
import { SortHeader, useSort } from "./sorting";
import { Sparkline } from "./Sparkline";
import { Card, CardHeader, DeltaBadge, GaLogo, GscLogo, Skeleton, SourceError } from "./ui";

const GREEN = "#1F4D36";
const COPPER = "#B8693D";
const RANGE_STORAGE_KEY = "insights.range";

export function DashboardView() {
  const [range, setRange] = useState<RangeKey>("28d");
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  // Show the result of a Google sign in, then tidy the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    if (params.get("connected")) {
      setNotice({ tone: "good", text: "Google account connected. You can change properties any time in Settings." });
    } else if (authError) {
      setNotice({ tone: "bad", text: `Couldn't connect Google: ${authError}` });
    }
    if (params.has("connected") || authError) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(RANGE_STORAGE_KEY);
      if (saved && RANGE_OPTIONS.some((o) => o.key === saved)) setRange(saved as RangeKey);
    } catch {
      /* storage unavailable, keep the default */
    }
  }, []);

  const load = useCallback(async (key: RangeKey, refresh = false) => {
    setLoading(true);
    setFailed(null);
    try {
      const res = await fetch(`/api/analytics/overview?range=${key}${refresh ? "&refresh=1" : ""}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Server responded with ${res.status}`);
      setData(body);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range);
  }, [range, load]);

  function changeRange(key: RangeKey) {
    setRange(key);
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, key);
    } catch {
      /* ignore */
    }
  }

  function navigate(id: string) {
    setActive(id);
    setMenuOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const ga = data?.ga;
  const gsc = data?.gsc;
  const usingDemo = ga?.status === "demo" || gsc?.status === "demo";
  const connection = data?.connection;

  return (
    <div className="min-h-screen bg-dash-bg font-dash text-dash-ink">
      <Sidebar
        active={active}
        onNavigate={navigate}
        integrations={data?.integrations ?? []}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />

      <main className="lg:pl-64">
        <div className="mx-auto max-w-[1400px] px-4 pb-16 pt-5 sm:px-8">
          {/* Header */}
          <header id="overview" className="scroll-mt-6">
            <div className="mb-4 flex items-center justify-between lg:hidden">
              <button
                onClick={() => setMenuOpen(true)}
                className="rounded-lg border border-dash-line bg-white p-2 text-dash-ink"
                aria-label="Open menu"
              >
                <MenuIcon className="h-5 w-5" />
              </button>
              <span className="font-serif text-lg">Insights</span>
            </div>

            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="font-serif text-3xl text-dash-ink sm:text-4xl">Welcome back!</h1>
                <p className="mt-1 text-dash-muted">
                  Your website performance from Google Analytics and Search Console in one place.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="flex items-center gap-2 rounded-xl border border-dash-line bg-white px-3.5 py-2.5 text-sm font-medium text-dash-ink hover:border-dash-green/40"
                  title={connection?.email ? `Connected as ${connection.email}` : undefined}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      connection && connection.mode !== "none" ? "bg-dash-up" : "bg-dash-copper"
                    }`}
                  />
                  {connection && connection.mode !== "none" ? "Settings" : "Connect Google"}
                </button>
                <select
                  value={range}
                  onChange={(e) => changeRange(e.target.value as RangeKey)}
                  className="rounded-xl border border-dash-line bg-white px-3.5 py-2.5 text-sm font-medium text-dash-ink focus:outline-none focus:ring-2 focus:ring-dash-green/30"
                  aria-label="Date range"
                >
                  {RANGE_OPTIONS.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => load(range, true)}
                  disabled={loading}
                  className="flex items-center gap-2 rounded-xl bg-dash-green px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-dash-deep disabled:opacity-60"
                >
                  <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                  Refresh
                </button>
              </div>
            </div>
            {data && (
              <p className="mt-3 text-xs text-dash-muted">
                {ga && <>Analytics: {formatRange(ga.range)}</>}
                {gsc && <> · Search Console: {formatRange(gsc.range)}</>}
                {" "}· Compared with the previous period · Updated{" "}
                {new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </p>
            )}
          </header>

          {failed && (
            <div className="mt-6 rounded-xl border border-dash-down/30 bg-dash-down/5 p-4 text-sm">
              Couldn&apos;t load the dashboard. {failed}
            </div>
          )}

          {notice && (
            <div
              className={`mt-6 flex items-center justify-between gap-3 rounded-xl border p-4 text-sm ${
                notice.tone === "good" ? "border-dash-up/30 bg-dash-up/5" : "border-dash-down/30 bg-dash-down/5"
              }`}
              role="status"
            >
              <span>{notice.text}</span>
              <button onClick={() => setNotice(null)} className="text-dash-muted" aria-label="Dismiss">
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
          )}

          {usingDemo && (
            <div className="mt-6 rounded-2xl border border-[#E7D3B4] bg-[#FBF1E1] p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-dash-ink">
                  <InfoIcon className="h-5 w-5 shrink-0 text-dash-copper" />
                  You&apos;re looking at sample data. Connect your Google account to see your real numbers.
                </p>
                {connection?.oauthAvailable ? (
                  <ConnectButton />
                ) : (
                  <button onClick={() => setShowSetup((s) => !s)} className="font-semibold text-dash-green hover:underline">
                    {showSetup ? "Hide steps" : "How to connect"}
                  </button>
                )}
              </div>
              {showSetup && !connection?.oauthAvailable && (
                <div className="mt-4">
                  <SetupSteps redirectUri={connection?.redirectUri} canSaveClient={connection?.canSaveClient} />
                  {connection?.canSaveClient && (
                    <button onClick={() => setSettingsOpen(true)} className="mt-3 font-semibold text-dash-green hover:underline">
                      Open Settings to paste your credentials
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* KPI row */}
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi
              icon={<UsersIcon className="h-5 w-5" />}
              label="Total Users"
              loading={loading && !data}
              value={ga?.data && formatNumber(ga.data.totals.users.value)}
              badge={ga?.data && <DeltaBadge delta={ga.data.totals.users} />}
              spark={ga?.data?.daily.map((d) => d.users)}
            />
            <Kpi
              icon={<FileIcon className="h-5 w-5" />}
              label="Page Views"
              loading={loading && !data}
              value={ga?.data && formatNumber(ga.data.totals.pageViews.value)}
              badge={ga?.data && <DeltaBadge delta={ga.data.totals.pageViews} />}
              spark={ga?.data?.daily.map((d) => d.pageViews)}
            />
            <Kpi
              icon={<ClockIcon className="h-5 w-5" />}
              label="Avg. Engagement Time"
              loading={loading && !data}
              value={ga?.data && formatDuration(ga.data.totals.avgEngagementSec.value)}
              badge={ga?.data && <DeltaBadge delta={ga.data.totals.avgEngagementSec} />}
            />
            <Kpi
              icon={<SearchIcon className="h-5 w-5" />}
              label="Organic Search Clicks"
              loading={loading && !data}
              value={gsc?.data && formatNumber(gsc.data.totals.clicks.value)}
              badge={gsc?.data && <DeltaBadge delta={gsc.data.totals.clicks} />}
              spark={gsc?.data?.daily.map((d) => d.clicks)}
            />
          </div>

          {/* GA + GSC charts */}
          <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card id="analytics">
              <CardHeader title="Google Analytics" icon={<GaLogo />} href={ga?.openUrl} linkLabel="Open GA">
              </CardHeader>
              {!ga || (loading && !data) ? (
                <Skeleton className="h-[300px]" />
              ) : ga.status === "error" ? (
                <SourceError source="Google Analytics" message={ga.error} />
              ) : (
                ga.data && (
                  <>
                    <div className="mb-4 grid grid-cols-3 gap-3 border-b border-dash-line pb-4">
                      <MiniStat label="Users" value={formatNumber(ga.data.totals.users.value)} badge={<DeltaBadge delta={ga.data.totals.users} />} />
                      <MiniStat label="Sessions" value={formatNumber(ga.data.totals.sessions.value)} badge={<DeltaBadge delta={ga.data.totals.sessions} />} />
                      <MiniStat label="Page Views" value={formatNumber(ga.data.totals.pageViews.value)} badge={<DeltaBadge delta={ga.data.totals.pageViews} />} />
                    </div>
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="font-serif text-lg">Users &amp; Page Views</h3>
                      <Legend items={[{ label: "Users", color: GREEN }, { label: "Page Views", color: COPPER }]} />
                    </div>
                    <LineChart
                      dates={ga.data.daily.map((d) => d.date)}
                      series={[
                        { label: "Users", color: GREEN, values: ga.data.daily.map((d) => d.users) },
                        { label: "Page Views", color: COPPER, values: ga.data.daily.map((d) => d.pageViews) },
                      ]}
                    />
                  </>
                )
              )}
            </Card>

            <Card id="search-console">
              <CardHeader title="Google Search Console" icon={<GscLogo />} href={gsc?.openUrl} linkLabel="Open GSC" />
              {!gsc || (loading && !data) ? (
                <Skeleton className="h-[300px]" />
              ) : gsc.status === "error" ? (
                <SourceError source="Search Console" message={gsc.error} />
              ) : (
                gsc.data && (
                  <>
                    <div className="mb-4 grid grid-cols-2 gap-3 border-b border-dash-line pb-4 sm:grid-cols-4">
                      <MiniStat label="Total Clicks" value={formatNumber(gsc.data.totals.clicks.value)} badge={<DeltaBadge delta={gsc.data.totals.clicks} />} />
                      <MiniStat label="Impressions" value={formatNumber(gsc.data.totals.impressions.value)} badge={<DeltaBadge delta={gsc.data.totals.impressions} />} />
                      <MiniStat label="Average CTR" value={formatPct(gsc.data.totals.ctr.value)} badge={<DeltaBadge delta={gsc.data.totals.ctr} />} />
                      <MiniStat label="Avg. Position" value={gsc.data.totals.position.value.toFixed(1)} badge={<DeltaBadge delta={gsc.data.totals.position} lowerIsBetter />} />
                    </div>
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="font-serif text-lg">Clicks &amp; Impressions</h3>
                      <Legend items={[{ label: "Clicks", color: GREEN }, { label: "Impressions", color: COPPER }]} />
                    </div>
                    <LineChart
                      dates={gsc.data.daily.map((d) => d.date)}
                      series={[
                        { label: "Clicks", color: GREEN, values: gsc.data.daily.map((d) => d.clicks) },
                        { label: "Impressions", color: COPPER, values: gsc.data.daily.map((d) => d.impressions), axis: "right" },
                      ]}
                    />
                  </>
                )
              )}
            </Card>
          </div>

          {/* Channels, pages, queries */}
          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-[0.9fr_1fr_1.2fr]">
            <Card>
              <CardHeader title="Top Traffic Channels" />
              {ga?.data ? (
                <DonutChart
                  slices={ga.data.channels.map((c) => ({ name: c.name, value: c.sessions, share: c.share }))}
                  centerValue={ga.data.totals.sessions.value}
                  centerLabel="Sessions"
                />
              ) : (
                <Placeholder loading={loading} />
              )}
            </Card>

            <Card id="pages">
              <CardHeader title="Top Pages" href={ga?.openUrl} linkLabel="Open GA" />
              {ga?.data ? (
                <Table
                  head={["Page", "Views", "Avg. Time"]}
                  rows={ga.data.topPages.map((p) => ({
                    cells: [p.path, formatNumber(p.views), formatDuration(p.avgTimeSec)],
                    values: [p.path, p.views, p.avgTimeSec],
                  }))}
                  empty="No page views in this period yet."
                />
              ) : (
                <Placeholder loading={loading} />
              )}
            </Card>

            <QueriesCard data={gsc?.data ?? null} openUrl={gsc?.openUrl} loading={loading} />
          </div>

          <KeywordResearch
            connection={connection}
            searchQueries={gsc?.data?.topQueries.map((q) => q.query) ?? []}
            range={range}
            onChanged={() => load(range, true)}
          />

          <ConnectedApps
            integrations={data?.integrations ?? []}
            onSetup={(id) => (id === "keywords" ? navigate("keywords") : setSettingsOpen(true))}
          />
        </div>
      </main>

      {settingsOpen && (
        <SettingsPanel
          connection={connection}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => load(range, true)}
        />
      )}
    </div>
  );
}

function Kpi({ icon, label, value, badge, spark, loading }: {
  icon: ReactNode;
  label: string;
  value?: string | null;
  badge?: ReactNode;
  spark?: number[];
  loading: boolean;
}) {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F1ECE3] text-dash-green">{icon}</div>
        <p className="text-sm text-dash-muted">{label}</p>
      </div>
      {loading ? (
        <Skeleton className="mt-4 h-8 w-28" />
      ) : (
        <div className="mt-3 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="font-serif text-3xl text-dash-ink">{value ?? "—"}</p>
            <div className="mt-1 flex items-center gap-2 whitespace-nowrap">
              {badge}
              <span className="hidden text-xs text-dash-muted 2xl:inline">vs. prior period</span>
            </div>
          </div>
          {spark && <Sparkline values={spark} />}
        </div>
      )}
    </Card>
  );
}

function MiniStat({ label, value, badge }: { label: string; value: string; badge: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-dash-muted">{label}</p>
      <p className="font-serif text-2xl text-dash-ink">{value}</p>
      {badge}
    </div>
  );
}

interface TableRow {
  /** What each cell shows. */
  cells: (string | number)[];
  /** What each column sorts by (raw numbers, not formatted text). */
  values: (string | number)[];
}

function Table({ head, rows, empty }: { head: string[]; rows: TableRow[]; empty: string }) {
  const columns = Object.fromEntries(head.map((_, i) => [String(i), (r: TableRow) => r.values[i]]));
  const { sorted, sort } = useSort(rows, columns, { key: "1", dir: "desc" });

  if (!rows.length) return <p className="py-8 text-center text-sm text-dash-muted">{empty}</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-dash-line text-left text-xs text-dash-ink">
            {head.map((h, i) => (
              <th key={h} className={`px-1 pb-2 ${i ? "text-right" : ""}`}>
                <SortHeader label={h} column={String(i)} sort={sort} align={i ? "right" : "left"} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={String(row.values[0])} className="border-b border-dash-line/70 last:border-0">
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  className={`px-1 py-2.5 ${i ? "whitespace-nowrap text-right tabular-nums" : "max-w-[220px] truncate text-dash-ink"}`}
                  title={i ? undefined : String(cell)}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueriesCard({ data, openUrl, loading }: {
  data: OverviewResponse["gsc"]["data"];
  openUrl?: string;
  loading: boolean;
}) {
  const [tab, setTab] = useState<"queries" | "pages">("queries");
  const tabs = (
    <div className="flex rounded-lg bg-[#F1ECE3] p-0.5 text-xs font-medium">
      {(["queries", "pages"] as const).map((t) => (
        <button
          key={t}
          onClick={() => setTab(t)}
          className={`rounded-md px-2.5 py-1 capitalize ${tab === t ? "bg-white text-dash-ink shadow-sm" : "text-dash-muted"}`}
        >
          {t}
        </button>
      ))}
    </div>
  );

  return (
    <Card id="queries" className="lg:col-span-2 2xl:col-span-1">
      <CardHeader title="Top Search Queries" href={openUrl} linkLabel="Open GSC">
        {tabs}
      </CardHeader>
      {!data ? (
        <Placeholder loading={loading} />
      ) : tab === "queries" ? (
        <Table
          head={["Query", "Clicks", "Impr.", "CTR", "Pos."]}
          rows={data.topQueries.map((q) => ({
            cells: [q.query, formatNumber(q.clicks), formatNumber(q.impressions), formatPct(q.ctr), q.position.toFixed(1)],
            values: [q.query, q.clicks, q.impressions, q.ctr, q.position],
          }))}
          empty="No search queries in this period yet."
        />
      ) : (
        <Table
          head={["Page", "Clicks", "Impr."]}
          rows={data.topPages.map((p) => ({
            cells: [shortUrl(p.page), formatNumber(p.clicks), formatNumber(p.impressions)],
            values: [shortUrl(p.page), p.clicks, p.impressions],
          }))}
          empty="No pages with search clicks in this period yet."
        />
      )}
    </Card>
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search || "/";
  } catch {
    return url;
  }
}

function Placeholder({ loading }: { loading: boolean }) {
  return loading ? (
    <Skeleton className="h-48" />
  ) : (
    <p className="py-8 text-center text-sm text-dash-muted">Data unavailable. See the message above.</p>
  );
}

const STATUS_STYLE: Record<IntegrationInfo["status"], string> = {
  connected: "bg-dash-up",
  demo: "bg-dash-copper",
  error: "bg-dash-down",
  coming_soon: "bg-[#C9C2B6]",
  setup: "bg-dash-copper",
};

function ConnectedApps({ integrations, onSetup }: {
  integrations: IntegrationInfo[];
  onSetup: (id: string) => void;
}) {
  return (
    <section id="apps" className="mt-5 scroll-mt-6 rounded-2xl border border-dash-line bg-[#EFF2EA] p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-xl">Connected Apps</h2>
          <p className="text-sm text-dash-muted">All your data sources in one place.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {integrations.map((app) => (
          <div key={app.id} className="flex flex-col justify-between gap-3 rounded-xl border border-dash-line bg-white p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F6F2EA]">
                {app.id === "ga4" ? (
                  <GaLogo className="h-5 w-5" />
                ) : app.id === "gsc" ? (
                  <GscLogo className="h-5 w-5" />
                ) : app.id === "keywords" ? (
                  <KeyIcon className="h-5 w-5 text-dash-green" />
                ) : (
                  <PlusIcon className="h-4 w-4 text-dash-muted" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight">{app.name}</p>
                <p className="mt-0.5 text-xs text-dash-muted">{app.description}</p>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs text-dash-muted">
                <span className={`h-2 w-2 rounded-full ${STATUS_STYLE[app.status]}`} />
                {app.detail}
              </span>
              {(app.status === "demo" || app.status === "error" || app.status === "setup") && (
                <button onClick={() => onSetup(app.id)} className="text-xs font-semibold text-dash-green hover:underline">
                  {app.status === "setup" ? "Set up" : "Connect"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
