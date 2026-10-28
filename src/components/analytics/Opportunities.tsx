"use client";

import { useEffect, useMemo, useState } from "react";
import type { Opportunity } from "@/lib/analytics/seo-types";
import type { RangeKey } from "@/lib/analytics/types";
import { formatNumber, formatPct } from "./format";
import { api, Explainer, pathOf, TrackButton } from "./seo-ui";
import { SortHeader, useSort } from "./sorting";
import { TopicsView } from "./TopicsView";
import { Skeleton } from "./ui";

export function Opportunities({ range, brand, isTracked, onTrack }: {
  range: RangeKey;
  /** Brand word to hide, e.g. "peremis". */
  brand: string;
  isTracked: (keyword: string) => boolean;
  onTrack: (keywords: string[]) => void;
}) {
  const [items, setItems] = useState<Opportunity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hideBrand, setHideBrand] = useState(true);
  const [view, setView] = useState<"list" | "topics">("list");

  useEffect(() => {
    setItems(null);
    setError(null);
    api<{ opportunities: Opportunity[] }>(`/api/seo/opportunities?range=${range}`)
      .then((d) => setItems(d.opportunities))
      .catch((err) => setError(err.message));
  }, [range]);

  const shown = useMemo(
    () => (items ?? []).filter((o) => !(hideBrand && brand && o.query.includes(brand))),
    [items, hideBrand, brand]
  );

  const { sorted, sort } = useSort(
    shown,
    {
      query: (o) => o.query,
      page: (o) => pathOf(o.page),
      position: (o) => o.position,
      impressions: (o) => o.impressions,
      clicks: (o) => o.clicks,
      potential: (o) => o.potentialClicks,
    },
    { key: "potential", dir: "desc" }
  );

  if (error) return <p className="rounded-lg bg-dash-down/5 p-3 text-sm text-dash-down">{error}</p>;
  if (!items) return <Skeleton className="h-64" />;

  return (
    <div>
      <Explainer>
        Searches where your site already shows up on Google in positions 4 to 20. These are the quickest wins: improving
        the page so it reaches the top 3 could bring roughly the extra clicks shown, for the same period as the dashboard.
      </Explainer>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="text-dash-muted">{formatNumber(shown.length)} opportunities</span>
          <div className="flex rounded-lg bg-[#F1ECE3] p-0.5 text-xs font-medium">
            {(["list", "topics"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-md px-2.5 py-1 ${view === v ? "bg-white text-dash-ink shadow-sm" : "text-dash-muted"}`}
              >
                {v === "topics" ? "Content ideas" : "List"}
              </button>
            ))}
          </div>
        </div>
        {brand && (
          <label className="flex items-center gap-2 text-dash-ink">
            <input id="hide-brand" type="checkbox" checked={hideBrand} onChange={(e) => setHideBrand(e.target.checked)} />
            Hide searches for &ldquo;{brand}&rdquo;
          </label>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-dash-muted">
          No searches in positions 4 to 20 for this period. Try a longer date range at the top of the page.
        </p>
      ) : view === "topics" ? (
        <TopicsView
          unit="impressions"
          onTrack={onTrack}
          ideas={[...new Map(shown.map((o) => [o.query, o])).values()].map((o) => ({
            keyword: o.query,
            avgMonthlySearches: shown.filter((x) => x.query === o.query).reduce((s, x) => s + x.impressions, 0),
            competition: "UNKNOWN" as const,
            competitionIndex: null,
            lowBid: null,
            highBid: null,
            trend: [],
          }))}
        />
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-dash-card">
              <tr className="border-b border-dash-line text-left text-xs font-semibold text-dash-ink">
                <th className="px-1 pb-2"><SortHeader label="Search" column="query" sort={sort} /></th>
                <th className="hidden px-1 pb-2 md:table-cell"><SortHeader label="Your page" column="page" sort={sort} /></th>
                <th className="px-1 pb-2 text-right"><SortHeader label="Position" column="position" sort={sort} align="right" /></th>
                <th className="hidden px-1 pb-2 text-right sm:table-cell"><SortHeader label="Impressions" column="impressions" sort={sort} align="right" /></th>
                <th className="hidden px-1 pb-2 text-right sm:table-cell"><SortHeader label="Clicks" column="clicks" sort={sort} align="right" /></th>
                <th className="px-1 pb-2 text-right"><SortHeader label="Extra clicks" column="potential" sort={sort} align="right" /></th>
                <th className="px-1 pb-2" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((o) => (
                <tr key={`${o.query}|${o.page}`} className="border-b border-dash-line/70 last:border-0">
                  <td className="max-w-[220px] truncate px-1 py-2 text-dash-ink" title={o.query}>{o.query}</td>
                  <td className="hidden max-w-[220px] truncate px-1 py-2 text-dash-muted md:table-cell" title={o.page}>
                    <a href={o.page} target="_blank" rel="noreferrer" className="hover:underline">{pathOf(o.page)}</a>
                  </td>
                  <td className="px-1 py-2 text-right tabular-nums">{o.position.toFixed(1)}</td>
                  <td className="hidden px-1 py-2 text-right tabular-nums sm:table-cell">{formatNumber(o.impressions)}</td>
                  <td className="hidden px-1 py-2 text-right tabular-nums sm:table-cell" title={`CTR ${formatPct(o.ctr)}`}>
                    {formatNumber(o.clicks)}
                  </td>
                  <td className="px-1 py-2 text-right font-semibold tabular-nums text-dash-up">+{formatNumber(o.potentialClicks)}</td>
                  <td className="px-1 py-2 text-right">
                    <TrackButton tracked={isTracked(o.query)} onClick={() => onTrack([o.query])} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
