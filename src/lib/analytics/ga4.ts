import { googleRequest, type GoogleAuth } from "./google-auth";
import { listDates, pctChange } from "./dates";
import type { Delta, GaData, PeriodRanges } from "./types";

interface Ga4Row {
  dimensionValues?: { value: string }[];
  metricValues?: { value: string }[];
}
interface Ga4Report {
  rows?: Ga4Row[];
}

export function envGa4PropertyId(): string | undefined {
  return process.env.GA4_PROPERTY_ID?.replace(/^properties\//, "").trim() || undefined;
}

export const ga4OpenUrl = (id: string) =>
  `https://analytics.google.com/analytics/web/#/p${id}/reports/intelligenthome`;

interface AccountSummaries {
  accountSummaries?: {
    displayName: string;
    propertySummaries?: { property: string; displayName: string }[];
  }[];
}

/** Every GA4 property the signed in Google account can read. */
export async function listGa4Properties(auth: GoogleAuth) {
  const body = await googleRequest<AccountSummaries>(
    auth,
    "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200"
  );
  return (body.accountSummaries ?? []).flatMap((a) =>
    (a.propertySummaries ?? []).map((p) => ({
      id: p.property.replace(/^properties\//, ""),
      name: p.displayName,
      account: a.displayName,
    }))
  );
}

const num = (row: Ga4Row | undefined, i: number) => Number(row?.metricValues?.[i]?.value ?? 0);

const delta = (value: number, previous: number): Delta => ({
  value,
  previous,
  change: pctChange(value, previous),
});

export async function fetchGa4(auth: GoogleAuth, id: string, ranges: PeriodRanges): Promise<GaData> {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`;
  const current = { startDate: ranges.current.start, endDate: ranges.current.end };

  const [summary, daily, channels, pages] = await Promise.all([
    googleRequest<Ga4Report>(auth, url, {
      dateRanges: [
        { ...current, name: "current" },
        { startDate: ranges.previous.start, endDate: ranges.previous.end, name: "previous" },
      ],
      metrics: [
        { name: "totalUsers" },
        { name: "screenPageViews" },
        { name: "sessions" },
        { name: "userEngagementDuration" },
        { name: "activeUsers" },
      ],
    }),
    googleRequest<Ga4Report>(auth, url, {
      dateRanges: [current],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "totalUsers" }, { name: "screenPageViews" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
    }),
    googleRequest<Ga4Report>(auth, url, {
      dateRanges: [current],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    }),
    googleRequest<Ga4Report>(auth, url, {
      dateRanges: [current],
      dimensions: [{ name: "pagePath" }],
      metrics: [
        { name: "screenPageViews" },
        { name: "userEngagementDuration" },
        { name: "activeUsers" },
      ],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 10,
    }),
  ]);

  // With two date ranges GA4 adds a "dateRange" dimension to each row.
  const byRange = (name: string) =>
    summary.rows?.find((r) => r.dimensionValues?.[0]?.value === name);
  const cur = byRange("current");
  const prev = byRange("previous");
  const avgEngagement = (row?: Ga4Row) => (num(row, 4) ? num(row, 3) / num(row, 4) : 0);

  // GA4 omits days with no traffic, so fill the gaps with zeros.
  const dailyMap = new Map(
    (daily.rows ?? []).map((r) => {
      const d = r.dimensionValues![0].value;
      return [`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, r];
    })
  );

  const channelRows = (channels.rows ?? []).map((r) => ({
    name: r.dimensionValues![0].value,
    sessions: num(r, 0),
  }));
  const top = channelRows.slice(0, 5);
  const rest = channelRows.slice(5).reduce((sum, c) => sum + c.sessions, 0);
  if (rest > 0) top.push({ name: "Other", sessions: rest });
  const totalSessions = top.reduce((sum, c) => sum + c.sessions, 0);

  return {
    totals: {
      users: delta(num(cur, 0), num(prev, 0)),
      pageViews: delta(num(cur, 1), num(prev, 1)),
      sessions: delta(num(cur, 2), num(prev, 2)),
      avgEngagementSec: delta(avgEngagement(cur), avgEngagement(prev)),
    },
    daily: listDates(ranges.current).map((date) => {
      const r = dailyMap.get(date);
      return { date, users: num(r, 0), pageViews: num(r, 1) };
    }),
    channels: top.map((c) => ({
      ...c,
      share: totalSessions ? (c.sessions / totalSessions) * 100 : 0,
    })),
    topPages: (pages.rows ?? []).map((r) => ({
      path: r.dimensionValues![0].value,
      views: num(r, 0),
      avgTimeSec: num(r, 2) ? num(r, 1) / num(r, 2) : 0,
    })),
  };
}
