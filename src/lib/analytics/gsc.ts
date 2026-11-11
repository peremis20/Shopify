import { googleRequest, type GoogleAuth } from "./google-auth";
import { addDays, listDates, pctChange, toIso, todayUtc } from "./dates";
import type { DateRange, Delta, GscData, GscFresh, PeriodRanges } from "./types";

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

  // Early hourly numbers: Google keeps about 10 days of them, a few hours behind real time.
  const freshRows = googleRequest<{ rows?: GscRow[] }>(auth, url, {
    startDate: toIso(addDays(todayUtc(), -3)),
    endDate: toIso(addDays(todayUtc(), 1)),
    dimensions: ["HOUR"],
    dataState: "HOURLY_ALL",
    rowLimit: 200,
  }).then(
    (r) => r.rows ?? [],
    (e) => {
      // The main report still loads; the error goes to the logs so the repair agent sees it.
      console.error("gsc hourly data failed", e instanceof Error ? e.message : e);
      return [] as GscRow[];
    }
  );

  // Extra splits: a failure is logged and leaves the main report whole.
  const extra = (dimensions: string[]) =>
    query(ranges.current, dimensions, 50).catch((e) => {
      console.error(`gsc ${dimensions[0]} split failed`, e instanceof Error ? e.message : e);
      return [] as GscRow[];
    });

  const [[cur], [prev], daily, queries, pages, hourly, deviceRows, appearanceRows] = await Promise.all([
    query(ranges.current, []),
    query(ranges.previous, []),
    query(ranges.current, ["date"], 500),
    query(ranges.current, ["query"]),
    query(ranges.current, ["page"]),
    freshRows,
    extra(["device"]),
    extra(["searchAppearance"]),
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
    fresh: summarizeHourly(hourly),
    devices: deviceSplit(deviceRows),
    appearances: appearanceList(appearanceRows),
  };
}

const DEVICE_NAMES: Record<string, string> = { MOBILE: "Mobile", DESKTOP: "Desktop", TABLET: "Tablet" };

/** Clicks, impressions, CTR (percent) and position per device, most clicks first. */
export function deviceSplit(rows: GscRow[]) {
  return rows
    .filter((r) => r.keys?.[0])
    .map((r) => ({
      device: DEVICE_NAMES[r.keys![0].toUpperCase()] ?? plainName(r.keys![0]),
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr * 100,
      position: r.position,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

const APPEARANCE_NAMES: Record<string, string> = {
  PRODUCT_SNIPPETS: "Product details",
  MERCHANT_LISTINGS: "Shopping listings",
  REVIEW_SNIPPET: "Review stars",
  FAQ_RICH_RESULTS: "FAQ",
  VIDEO: "Video",
  RECIPE_RICH_RESULTS: "Recipe",
  RICHCARD: "Rich card",
  AMP_BLUE_LINK: "AMP",
  TRANSLATED_RESULT: "Translated result",
};

/** Each way the site's results showed in Google, most impressions first. */
export function appearanceList(rows: GscRow[]) {
  return rows
    .filter((r) => r.keys?.[0])
    .map((r) => ({
      type: APPEARANCE_NAMES[r.keys![0].toUpperCase()] ?? plainName(r.keys![0]),
      clicks: r.clicks,
      impressions: r.impressions,
    }))
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
}

/** "SOME_GOOGLE_NAME" as "Some google name": plain words, no underscores. */
function plainName(key: string) {
  const words = key.replace(/[_\s-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Totals for the 24 hours before `now`, or null when Google reported none in that time. */
export function summarizeHourly(rows: GscRow[], now = Date.now()): GscFresh | null {
  const hours = rows
    .filter((r) => r.keys?.[0] && Date.parse(r.keys[0]) > now - 24 * 3600_000)
    .sort((a, b) => Date.parse(a.keys![0]) - Date.parse(b.keys![0]));
  if (!hours.length) return null;
  const latest = Date.parse(hours[hours.length - 1].keys![0]);
  return {
    clicks: hours.reduce((n, r) => n + r.clicks, 0),
    impressions: hours.reduce((n, r) => n + r.impressions, 0),
    hours: hours.length,
    latestHour: new Date(latest).toISOString(),
  };
}
