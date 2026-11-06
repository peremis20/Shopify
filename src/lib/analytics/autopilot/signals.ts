import type { Connection } from "../connection";
import { toIso } from "../dates";
import { googleRequest, type GoogleAuth } from "../google-auth";
import type { Opportunity } from "../seo-types";

/**
 * Search Console and Analytics signals for the autopilot:
 * - slipping: searches where a page held the top spots and is losing ground
 * - near the top: page one searches at #2 or #3 worth a push for #1
 * - page value: how visitors from search behave on each page (GA4)
 */

interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  position: number;
}

const DAY = 86_400_000;
const LAG_DAYS = 3; // Search Console data settles after a couple of days.

function window(daysBack: number, length: number) {
  const end = new Date(Date.now() - (LAG_DAYS + daysBack) * DAY);
  return { startDate: toIso(new Date(end.getTime() - (length - 1) * DAY)), endDate: toIso(end) };
}

async function queryPageRows(conn: Connection, range: { startDate: string; endDate: string }): Promise<GscRow[]> {
  const body = await googleRequest<{ rows?: GscRow[] }>(
    { kind: "oauth", refreshToken: conn.refreshToken },
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(conn.gscSiteUrl!)}/searchAnalytics/query`,
    { ...range, dimensions: ["query", "page"], rowLimit: 5000 }
  );
  return body.rows ?? [];
}

export interface Slipping extends Opportunity {
  /** Average position over the 4 weeks before the last week. */
  previousPosition: number;
}

const key = (r: GscRow) => `${r.keys[0]}\n${r.keys[1]}`;

/**
 * Compares the last 7 days with the 4 weeks before. Returns page one searches
 * that slipped (top 3 by 0.8+ positions, the rest of page one by 2+), and
 * #2 to #3 searches that could reach #1, both worst or biggest first.
 */
export async function topPositionSignals(conn: Connection): Promise<{ slipping: Slipping[]; nearTop: Opportunity[] }> {
  const [recent, before] = await Promise.all([queryPageRows(conn, window(0, 7)), queryPageRows(conn, window(7, 28))]);
  const prior = new Map(before.map((r) => [key(r), r]));
  const toOp = (r: GscRow): Opportunity => ({
    query: r.keys[0],
    page: r.keys[1],
    position: r.position,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.impressions ? (r.clicks / r.impressions) * 100 : 0,
    potentialClicks: 0,
  });

  const slipping: Slipping[] = [];
  for (const r of recent) {
    const p = prior.get(key(r));
    if (!p || p.impressions < 20 || p.position > 10) continue;
    const drop = r.position - p.position;
    if ((p.position <= 3.5 && drop >= 0.8) || drop >= 2) {
      // Clicks a month at risk: the old click rate on the searches seen in a month.
      slipping.push({ ...toOp(r), previousPosition: p.position, potentialClicks: Math.round(p.clicks * (drop / Math.max(1, p.position))) });
    }
  }
  slipping.sort((a, b) => b.potentialClicks - a.potentialClicks || b.impressions - a.impressions);

  const nearTop = before
    .filter((r) => r.position > 1.5 && r.position <= 3.5 && r.impressions >= 50)
    .map((r) => ({ ...toOp(r), potentialClicks: Math.round(r.impressions * Math.max(0, 0.28 - r.clicks / r.impressions)) }))
    .sort((a, b) => b.potentialClicks - a.potentialClicks);

  return { slipping, nearTop };
}

export interface PageValue {
  sessions: number;
  engagementRate: number;
  keyEvents: number;
  /** Revenue from these visitors (ecommerce tracking), 0 when not tracked. */
  revenue: number;
}

/** GA4 landing page behaviour for visitors from organic search, last 28 days, by path. */
export async function pageValues(conn: Connection): Promise<Map<string, PageValue>> {
  if (!conn.gaPropertyId) return new Map();
  const auth: GoogleAuth = { kind: "oauth", refreshToken: conn.refreshToken };
  const body = await googleRequest<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
    auth,
    `https://analyticsdata.googleapis.com/v1beta/properties/${conn.gaPropertyId}:runReport`,
    {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "landingPage" }],
      metrics: [{ name: "sessions" }, { name: "engagementRate" }, { name: "keyEvents" }, { name: "purchaseRevenue" }],
      dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } },
      limit: 1000,
    }
  );
  const out = new Map<string, PageValue>();
  for (const r of body.rows ?? []) {
    // The same page with different query strings comes back as separate rows: add them up.
    const path = r.dimensionValues[0].value.split("?")[0];
    const sessions = Number(r.metricValues[0].value);
    const prev = out.get(path);
    const total = (prev?.sessions ?? 0) + sessions;
    out.set(path, {
      sessions: total,
      engagementRate: total ? ((prev?.engagementRate ?? 0) * (prev?.sessions ?? 0) + Number(r.metricValues[1].value) * sessions) / total : 0,
      keyEvents: (prev?.keyEvents ?? 0) + Number(r.metricValues[2].value),
      revenue: (prev?.revenue ?? 0) + (Number(r.metricValues[3]?.value ?? 0) || 0),
    });
  }
  return out;
}

/** Pages that turn search visitors into sales or sign ups count up to twice as much. */
export function valueWeight(v: PageValue | undefined): number {
  if (!v || v.sessions < 5) return 1;
  return 1 + Math.min(1, (v.keyEvents / v.sessions) * 10);
}

export interface ChannelResult {
  sessions: number;
  /** Key events set up in Google Analytics: leads, sign ups or sales. */
  keyEvents: number;
  purchases: number;
  revenue: number;
}

export interface WeekResults {
  /** By Google Analytics channel (Organic Search, Referral, Direct, ...), last 7 full days and the 7 before. */
  channels: { name: string; now: ChannelResult; before: ChannelResult }[];
  /** Visits from each referring site, last 7 full days. */
  sources: Map<string, ChannelResult>;
}

const emptyResult = (): ChannelResult => ({ sessions: 0, keyEvents: 0, purchases: 0, revenue: 0 });

/** What visitors did after arriving, by channel and by referring site, from the site's own Google Analytics. */
export async function weekResults(conn: Connection): Promise<WeekResults | null> {
  if (!conn.gaPropertyId) return null;
  const auth: GoogleAuth = { kind: "oauth", refreshToken: conn.refreshToken };
  type Rows = { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] };
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${conn.gaPropertyId}:runReport`;
  const metrics = [{ name: "sessions" }, { name: "keyEvents" }, { name: "ecommercePurchases" }, { name: "purchaseRevenue" }];
  // Channels and referring sites are asked separately, so a long list of sites never cuts the channel totals short.
  const [byChannel, bySource] = await Promise.all([
    googleRequest<Rows>(auth, url, {
      dateRanges: [
        { startDate: "7daysAgo", endDate: "yesterday", name: "now" },
        { startDate: "14daysAgo", endDate: "8daysAgo", name: "before" },
      ],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics,
      limit: 100,
    }),
    googleRequest<Rows>(auth, url, {
      dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "sessionSource" }],
      metrics,
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 1000,
    }),
  ]);
  const channels = new Map<string, { now: ChannelResult; before: ChannelResult }>();
  const sources = new Map<string, ChannelResult>();
  const add = (into: ChannelResult, m: { value: string }[]) => {
    into.sessions += Number(m[0]?.value ?? 0) || 0;
    into.keyEvents += Number(m[1]?.value ?? 0) || 0;
    into.purchases += Number(m[2]?.value ?? 0) || 0;
    into.revenue += Number(m[3]?.value ?? 0) || 0;
  };
  for (const r of byChannel.rows ?? []) {
    // With two date ranges, Analytics adds the range's name as the last dimension.
    const [channel, range] = r.dimensionValues.map((d) => d.value);
    const c = channels.get(channel) ?? { now: emptyResult(), before: emptyResult() };
    channels.set(channel, c);
    add(range === "before" ? c.before : c.now, r.metricValues);
  }
  for (const r of bySource.rows ?? []) {
    const key = r.dimensionValues[0].value.toLowerCase().replace(/^www\./, "");
    const s = sources.get(key) ?? emptyResult();
    sources.set(key, s);
    add(s, r.metricValues);
  }
  return {
    channels: [...channels.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.now.sessions - a.now.sessions),
    sources,
  };
}
