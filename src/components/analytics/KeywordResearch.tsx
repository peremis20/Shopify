"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KEYWORD_LANGUAGES,
  KEYWORD_LOCATIONS,
  formatCustomerId,
  type Competition,
  type KeywordIdea,
  type KeywordStatus,
} from "@/lib/analytics/keyword-options";
import type { KeywordList } from "@/lib/analytics/seo-types";
import type { ConnectionInfo, RangeKey } from "@/lib/analytics/types";
import { formatNumber } from "./format";
import { DownloadIcon, KeyIcon } from "./Icons";
import { Opportunities } from "./Opportunities";
import { RankTracker } from "./RankTracker";
import { api, TrackButton } from "./seo-ui";
import { TopicsView } from "./TopicsView";
import { ConnectButton } from "./SettingsPanel";
import { Sparkline } from "./Sparkline";
import { Card, CardHeader, Skeleton } from "./ui";

type Tab = "ideas" | "opportunities" | "tracker";

const TABS: { id: Tab; label: string }[] = [
  { id: "opportunities", label: "Opportunities" },
  { id: "tracker", label: "Rank tracker" },
  { id: "ideas", label: "Keyword ideas" },
];

const COMPETITION_STYLE: Record<Competition, string> = {
  LOW: "bg-dash-up/10 text-dash-up",
  MEDIUM: "bg-dash-copper/15 text-dash-copper",
  HIGH: "bg-dash-down/10 text-dash-down",
  UNSPECIFIED: "bg-[#F1ECE3] text-dash-muted",
  UNKNOWN: "bg-[#F1ECE3] text-dash-muted",
};

type SortKey = "searches" | "bid" | "competition";

const siteFromProperty = (site?: string) =>
  site ? site.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "") : "";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export function KeywordResearch({ connection, searchQueries, range, onChanged }: {
  connection: ConnectionInfo | undefined;
  /** Search Console queries, for the "check my queries" shortcut. */
  searchQueries: string[];
  range: RangeKey;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<KeywordStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("opportunities");
  const [lists, setLists] = useState<KeywordList[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const connected = connection?.mode === "oauth";
  const site = siteFromProperty(connection?.gscSiteUrl);
  const brand = site.split(".")[0].replace(/^www$/, "");

  useEffect(() => {
    if (!connected) return;
    api<{ lists: KeywordList[] }>("/api/seo/lists")
      .then((d) => {
        setLists(d.lists);
        setActiveId((id) => id ?? d.lists[0]?.id ?? null);
      })
      .catch(() => setLists([]));
  }, [connected]);

  async function updateLists(body: Record<string, unknown>) {
    try {
      const d = await api<{ lists: KeywordList[] }>("/api/seo/lists/update", body);
      setLists(d.lists);
      if (body.action === "create" || !d.lists.some((l) => l.id === activeId)) {
        setActiveId(body.action === "create" ? d.lists.at(-1)?.id ?? null : d.lists[0]?.id ?? null);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't update the list");
    }
  }

  const active = lists?.find((l) => l.id === activeId) ?? null;
  const isTracked = (k: string) => Boolean(active?.keywords.includes(k.trim().toLowerCase()));

  function track(keywords: string[]) {
    const name = active?.name ?? "My keywords";
    (active
      ? updateLists({ action: "add", listId: active.id, keywords })
      : updateLists({ action: "create", name, keywords })
    ).then(() => setNotice(`Added ${keywords.length === 1 ? `“${keywords[0]}”` : `${keywords.length} keywords`} to ${name}.`));
  }

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const refreshStatus = useCallback(() => {
    setStatusError(null);
    fetch("/api/keywords/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatusError("Couldn't check the Keyword Planner setup."));
  }, []);

  useEffect(() => {
    if (connection?.mode === "oauth") refreshStatus();
  }, [connection?.mode, refreshStatus]);

  const setupDone = () => {
    refreshStatus();
    onChanged();
  };

  return (
    <Card id="keywords" className="mt-5">
      <CardHeader
        title="SEO Tools"
        icon={<KeyIcon className="h-5 w-5 text-dash-green" />}
        href="https://ads.google.com/aw/keywordplanner/home"
        linkLabel="Open Keyword Planner"
      />
      {!connected ? (
        <p className="text-sm text-dash-muted">
          Connect your Google account in Settings first. Keyword research uses the same sign in.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="flex rounded-lg bg-[#F1ECE3] p-0.5 text-sm font-medium" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`rounded-md px-3 py-1.5 ${tab === t.id ? "bg-white text-dash-ink shadow-sm" : "text-dash-muted"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {notice && <span className="text-sm text-dash-up" role="status">{notice}</span>}
          </div>

          {tab === "opportunities" && (
            <Opportunities range={range} brand={brand} isTracked={isTracked} onTrack={track} />
          )}
          {tab === "tracker" && (
            <RankTracker lists={lists} activeId={activeId} setActiveId={setActiveId} update={updateLists} />
          )}
          {tab === "ideas" &&
            (statusError ? (
              <p className="text-sm text-dash-down">{statusError}</p>
            ) : !status ? (
              <Skeleton className="h-24" />
            ) : status.step === "ready" ? (
              <KeywordTool site={site} searchQueries={searchQueries} isTracked={isTracked} onTrack={track} />
            ) : (
              <KeywordSetup status={status} onSaved={setupDone} />
            ))}
        </>
      )}
    </Card>
  );
}

function KeywordSetup({ status, onSaved }: { status: KeywordStatus; onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [manager, setManager] = useState(status.loginCustomerId ?? "");
  const [account, setAccount] = useState(status.accounts?.[0] ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(body: Record<string, string>) {
    setSaving(true);
    setError(null);
    try {
      await post("/api/keywords/settings", body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  if (status.step === "connect" || status.step === "reconnect") {
    return (
      <div className="space-y-3 text-sm">
        <p>
          Keyword research reads Google&apos;s Keyword Planner, which needs one more permission on your Google account.
          Reconnect once to allow it. Your Analytics and Search Console choices stay the same.
        </p>
        <ConnectButton label="Reconnect Google" />
      </div>
    );
  }

  return (
    <div className="grid gap-5 text-sm lg:grid-cols-2">
      <div className="space-y-2">
        <p className="font-semibold">Finish setting up Keyword Planner</p>
        <ol className="list-decimal space-y-1.5 pl-5 text-dash-ink marker:text-dash-muted">
          <li>
            Sign in to <b>ads.google.com</b> with the same Google account. If you have no Ads account, create one; no ads or
            billing are needed.
          </li>
          <li>
            In your Google Cloud project, enable the <b>Google Ads API</b> under APIs &amp; Services.
          </li>
          <li>
            In Google Ads, open <b>Admin</b>, then <b>API Center</b>, copy your <b>developer token</b>, and apply for{" "}
            <b>Basic access</b> if it says test account only.
          </li>
        </ol>
      </div>

      <div className="space-y-3">
        {status.error && <p className="rounded-lg bg-dash-down/5 p-3 text-dash-down">{status.error}</p>}

        {status.step === "token" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save({ developerToken: token, loginCustomerId: manager });
            }}
            className="space-y-3 rounded-xl border border-dash-line bg-white p-4"
          >
            <label className="block">
              <span className="mb-1 block text-xs text-dash-muted">Developer token</span>
              <input
                id="ads-developer-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                placeholder="22 characters from API Center"
                className="w-full rounded-lg border border-dash-line px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-dash-muted">Manager account ID (only if you use one)</span>
              <input
                id="ads-manager-id"
                value={manager}
                onChange={(e) => setManager(e.target.value)}
                placeholder="123-456-7890"
                className="w-full rounded-lg border border-dash-line px-3 py-2"
              />
            </label>
            {error && <p className="text-dash-down">{error}</p>}
            <button
              type="submit"
              disabled={saving || !token}
              className="rounded-xl bg-dash-green px-5 py-2.5 font-semibold text-white hover:bg-dash-deep disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save token"}
            </button>
          </form>
        )}

        {status.step === "account" && (status.accounts?.length ?? 0) > 0 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save({ customerId: account });
            }}
            className="space-y-3 rounded-xl border border-dash-line bg-white p-4"
          >
            <label className="block">
              <span className="mb-1 block text-xs text-dash-muted">Google Ads account to use</span>
              <select
                id="ads-account"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                className="w-full rounded-lg border border-dash-line bg-white px-3 py-2"
              >
                {status.accounts!.map((a) => (
                  <option key={a} value={a}>
                    {formatCustomerId(a)}
                  </option>
                ))}
              </select>
            </label>
            {error && <p className="text-dash-down">{error}</p>}
            <button
              type="submit"
              disabled={saving || !account}
              className="rounded-xl bg-dash-green px-5 py-2.5 font-semibold text-white hover:bg-dash-deep disabled:opacity-60"
            >
              {saving ? "Saving…" : "Use this account"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function KeywordTool({ site, searchQueries, isTracked, onTrack }: {
  site: string;
  searchQueries: string[];
  isTracked: (keyword: string) => boolean;
  onTrack: (keywords: string[]) => void;
}) {
  const [view, setView] = useState<"keywords" | "topics">("keywords");
  const [keywords, setKeywords] = useState("");
  const [url, setUrl] = useState(site);
  const [geo, setGeo] = useState("2840");
  const [language, setLanguage] = useState("1000");
  const [ideas, setIdeas] = useState<KeywordIdea[] | null>(null);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("searches");

  async function run(kind: "ideas" | "volumes", body: Record<string, unknown>, what: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await post<{ ideas: KeywordIdea[] }>(`/api/keywords/${kind}`, { ...body, geo, language });
      setIdeas(data.ideas);
      setLabel(what);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const sorted = useMemo(() => {
    if (!ideas) return [];
    const rank = { HIGH: 3, MEDIUM: 2, LOW: 1, UNSPECIFIED: 0, UNKNOWN: 0 };
    const by: Record<SortKey, (i: KeywordIdea) => number> = {
      searches: (i) => i.avgMonthlySearches ?? -1,
      bid: (i) => i.highBid ?? -1,
      competition: (i) => rank[i.competition],
    };
    return [...ideas].sort((a, b) => by[sort](b) - by[sort](a));
  }, [ideas, sort]);

  function downloadCsv() {
    const rows = [
      ["Keyword", "Avg. monthly searches", "Competition", "Competition index", "Low bid", "High bid"],
      ...sorted.map((i) => [
        i.keyword,
        i.avgMonthlySearches ?? "",
        i.competition,
        i.competitionIndex ?? "",
        i.lowBid?.toFixed(2) ?? "",
        i.highBid?.toFixed(2) ?? "",
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = "keyword-ideas.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const header = (key: SortKey, text: string) => (
    <button onClick={() => setSort(key)} className={`font-semibold ${sort === key ? "text-dash-green" : ""}`}>
      {text}
      {sort === key ? " ↓" : ""}
    </button>
  );

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const list = keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
          run("ideas", { keywords: list, url }, list.length ? list.join(", ") : url);
        }}
        className="grid gap-3 md:grid-cols-[1.4fr_1fr_auto_auto_auto] md:items-end"
      >
        <label className="block min-w-0">
          <span className="mb-1 block text-xs text-dash-muted">Keywords (separate with commas)</span>
          <input
            id="kw-seed"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="brain supplements, magnesium glycinate"
            className="w-full rounded-lg border border-dash-line bg-white px-3 py-2 text-sm"
          />
        </label>
        <label className="block min-w-0">
          <span className="mb-1 block text-xs text-dash-muted">Website (optional)</span>
          <input
            id="kw-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="peremis.com"
            className="w-full rounded-lg border border-dash-line bg-white px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-dash-muted">Location</span>
          <select
            id="kw-geo"
            value={geo}
            onChange={(e) => setGeo(e.target.value)}
            className="w-full rounded-lg border border-dash-line bg-white px-3 py-2 text-sm"
          >
            {KEYWORD_LOCATIONS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-dash-muted">Language</span>
          <select
            id="kw-language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-lg border border-dash-line bg-white px-3 py-2 text-sm"
          >
            {KEYWORD_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={loading || (!keywords.trim() && !url.trim())}
          className="rounded-xl bg-dash-green px-5 py-2.5 text-sm font-semibold text-white hover:bg-dash-deep disabled:opacity-60"
        >
          Get ideas
        </button>
      </form>

      <div className="text-sm">
        <button
          onClick={() => run("volumes", { keywords: searchQueries }, "your Search Console queries")}
          disabled={loading || !searchQueries.length}
          className="font-semibold text-dash-green hover:underline disabled:text-dash-muted disabled:no-underline"
          title={searchQueries.length ? undefined : "No Search Console queries in this period yet"}
        >
          Check search volume for my Search Console queries
        </button>
      </div>

      {error && <p className="rounded-lg bg-dash-down/5 p-3 text-sm text-dash-down">{error}</p>}

      {loading ? (
        <Skeleton className="h-64" />
      ) : ideas && (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <p className="text-dash-muted">
              {formatNumber(ideas.length)} keywords for <span className="text-dash-ink">{label}</span>
            </p>
            {ideas.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex rounded-lg bg-[#F1ECE3] p-0.5 text-xs font-medium">
                  {(["keywords", "topics"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setView(v)}
                      className={`rounded-md px-2.5 py-1 capitalize ${view === v ? "bg-white text-dash-ink shadow-sm" : "text-dash-muted"}`}
                    >
                      {v === "topics" ? "Content ideas" : "Keywords"}
                    </button>
                  ))}
                </div>
                <TrackButton label="Track all" onClick={() => onTrack(sorted.map((i) => i.keyword))} />
                <button onClick={downloadCsv} className="flex items-center gap-1.5 font-semibold text-dash-green hover:underline">
                  <DownloadIcon className="h-4 w-4" />
                  Download CSV
                </button>
              </div>
            )}
          </div>
          {ideas.length === 0 ? (
            <p className="py-8 text-center text-sm text-dash-muted">Google returned no ideas. Try broader keywords.</p>
          ) : view === "topics" ? (
            <TopicsView ideas={ideas} onTrack={onTrack} />
          ) : (
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-dash-card">
                  <tr className="border-b border-dash-line text-left text-xs text-dash-ink">
                    <th className="px-1 pb-2 font-semibold">Keyword</th>
                    <th className="px-1 pb-2 text-right">{header("searches", "Monthly searches")}</th>
                    <th className="hidden px-1 pb-2 font-semibold sm:table-cell">12 month trend</th>
                    <th className="px-1 pb-2 text-left">{header("competition", "Competition")}</th>
                    <th className="hidden px-1 pb-2 text-right md:table-cell">{header("bid", "Top of page bid")}</th>
                    <th className="px-1 pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((i) => (
                    <tr key={i.keyword} className="border-b border-dash-line/70 last:border-0">
                      <td className="max-w-[260px] truncate px-1 py-2 text-dash-ink" title={i.keyword}>{i.keyword}</td>
                      <td className="whitespace-nowrap px-1 py-2 text-right tabular-nums">
                        {i.avgMonthlySearches === null ? "—" : formatNumber(i.avgMonthlySearches)}
                      </td>
                      <td className="hidden px-1 py-1 sm:table-cell">
                        {i.trend.length > 1 && <Sparkline values={i.trend.map((t) => t.searches)} />}
                      </td>
                      <td className="px-1 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${COMPETITION_STYLE[i.competition]}`}>
                          {i.competition === "UNSPECIFIED" || i.competition === "UNKNOWN" ? "n/a" : i.competition.toLowerCase()}
                        </span>
                      </td>
                      <td className="hidden whitespace-nowrap px-1 py-2 text-right tabular-nums md:table-cell">
                        {i.lowBid === null && i.highBid === null
                          ? "—"
                          : `${i.lowBid?.toFixed(2) ?? "?"} to ${i.highBid?.toFixed(2) ?? "?"}`}
                      </td>
                      <td className="px-1 py-2 text-right">
                        <TrackButton tracked={isTracked(i.keyword)} onClick={() => onTrack([i.keyword])} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-dash-muted">
            Data from Google Keyword Planner. Bids are in your Google Ads account currency. Accounts with little or no ad
            spend see rounded search volumes.
          </p>
        </div>
      )}
    </div>
  );
}
