import { googleRequest, type GoogleAuth } from "./google-auth";
import { listDates, pctChange } from "./dates";
import type { DateRange, Delta, GscData, PeriodRanges } from "./types";

interface GscRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export function envGscSiteUrl(): string | undefined {
  return process.env.GSC_SITE_URL?.trim() || undefined;
}

export const gscOpenUrl = (site: string) =>
  `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(site)}`;

/** Every Search Console property the signed in Google account can read. */
export async function listGscSites(auth: GoogleAuth) {
  const body = await googleRequest<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(
    auth,
    "https://www.googleapis.com/webmasters/v3/sites"
  );
  return (body.siteEntry ?? [])
    .filter((s) => s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => s.siteUrl)
    .sort((a, b) => Number(b.startsWith("sc-domain:")) - Number(a.startsWith("sc-domain:")));
}

const delta = (value: number, previous: number): Delta => ({
  value,
  previous,
  change: pctChange(value, previous),
});

export async function fetchGsc(auth: GoogleAuth, site: string, ranges: PeriodRanges): Promise<GscData> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;

  const query = (range: DateRange, dimensions: string[], rowLimit = 10) =>
    googleRequest<{ rows?: GscRow[] }>(auth, url, {
      startDate: range.start,
      endDate: range.end,
      dimensions,
      rowLimit,
    }).then((r) => r.rows ?? []);

  const [[cur], [prev], daily, queries, pages] = await Promise.all([
    query(ranges.current, []),
    query(ranges.previous, []),
    query(ranges.current, ["date"], 500),
    query(ranges.current, ["query"]),
    query(ranges.current, ["page"]),
  ]);

  const dailyMap = new Map(daily.map((r) => [r.keys![0], r]));

  return {
    totals: {
      clicks: delta(cur?.clicks ?? 0, prev?.clicks ?? 0),
      impressions: delta(cur?.impressions ?? 0, prev?.impressions ?? 0),
      ctr: delta((cur?.ctr ?? 0) * 100, (prev?.ctr ?? 0) * 100),
      position: delta(cur?.position ?? 0, prev?.position ?? 0),
    },
    daily: listDates(ranges.current).map((date) => ({
      date,
      clicks: dailyMap.get(date)?.clicks ?? 0,
      impressions: dailyMap.get(date)?.impressions ?? 0,
    })),
    topQueries: queries.map((r) => ({
      query: r.keys![0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr * 100,
      position: r.position,
    })),
    topPages: pages.map((r) => ({
      page: r.keys![0],
      clicks: r.clicks,
      impressions: r.impressions,
    })),
  };
}
