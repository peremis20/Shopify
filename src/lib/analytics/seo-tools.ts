import type { Connection } from "./connection";
import { ensureSchema, sql } from "./db";
import { googleRequest, type GoogleAuth } from "./google-auth";
import { listDates, resolveRange, toIso } from "./dates";
import type { KeywordList, Opportunity, Ranking, RankingWeek } from "./seo-types";
import type { RangeKey } from "./types";

/**
 * SEO tools built on Search Console: the opportunity finder, saved keyword
 * lists, and the ranking tracker (which reads past positions straight from
 * Search Console, so it has 16 months of history from day one).
 */

interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Typical share of clicks by Google position, used to estimate upside. */
const CTR_BY_POSITION = [0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02];
const TARGET_POSITION = 3;

function gscQuery(auth: GoogleAuth, site: string, body: Record<string, unknown>) {
  return googleRequest<{ rows?: GscRow[] }>(
    auth,
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    body
  ).then((r) => r.rows ?? []);
}

function requireSite(conn: Connection): { auth: GoogleAuth; site: string } {
  if (!conn.gscSiteUrl) throw new Error("Choose a Search Console property in Settings first.");
  return { auth: { kind: "oauth", refreshToken: conn.refreshToken }, site: conn.gscSiteUrl };
}

/** Searches where you show up on Google but just outside the top results. */
export async function findOpportunities(conn: Connection, rangeKey: RangeKey): Promise<Opportunity[]> {
  const { auth, site } = requireSite(conn);
  const { current } = resolveRange(rangeKey, 3);
  const rows = await gscQuery(auth, site, {
    startDate: current.start,
    endDate: current.end,
    dimensions: ["query", "page"],
    rowLimit: 5000,
  });

  const targetCtr = CTR_BY_POSITION[TARGET_POSITION - 1];
  return rows
    .filter((r) => r.position >= 4 && r.position <= 20 && r.impressions >= 3)
    .map((r) => ({
      query: r.keys[0],
      page: r.keys[1],
      position: r.position,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr * 100,
      potentialClicks: Math.max(0, Math.round(r.impressions * targetCtr - r.clicks)),
    }))
    .sort((a, b) => b.potentialClicks - a.potentialClicks || b.impressions - a.impressions)
    .slice(0, 50);
}

/**
 * How many searches Search Console has for the site in the last 28 days.
 * Few means the property is new (Google takes days to report) or the site
 * barely shows up yet; the autopilot then works from Keyword Planner too.
 */
export async function gscSearchCount(conn: Connection): Promise<number> {
  if (!conn.gscSiteUrl) return 0;
  const { auth, site } = requireSite(conn);
  const { current } = resolveRange("28d", 3);
  const rows = await gscQuery(auth, site, { startDate: current.start, endDate: current.end, dimensions: ["query"], rowLimit: 100 });
  return rows.length;
}

/** Below this many searches, Search Console alone is too thin to work from. */
export const THIN_GSC = 20;

// ---------- saved keyword lists ----------

export const normalizeKeyword = (k: string) => k.trim().toLowerCase().replace(/\s+/g, " ");

export async function getLists(accountId: string): Promise<KeywordList[]> {
  await ensureSchema();
  const lists = await sql`SELECT id, name FROM insights_keyword_lists WHERE account_id = ${accountId} ORDER BY created_at`;
  const words = await sql`
    SELECT k.list_id, k.keyword FROM insights_tracked_keywords k
    JOIN insights_keyword_lists l ON l.id = k.list_id
    WHERE l.account_id = ${accountId} ORDER BY k.added_at`;
  return lists.map((l) => ({
    id: l.id!,
    name: l.name!,
    keywords: words.filter((w) => w.list_id === l.id).map((w) => w.keyword!),
  }));
}

export async function createList(accountId: string, name: string): Promise<KeywordList> {
  await ensureSchema();
  const [row] = await sql`INSERT INTO insights_keyword_lists (account_id, name) VALUES (${accountId}, ${name}) RETURNING id, name`;
  return { id: row.id!, name: row.name!, keywords: [] };
}

export async function deleteList(accountId: string, id: string): Promise<void> {
  await ensureSchema();
  await sql`DELETE FROM insights_keyword_lists WHERE id = ${id} AND account_id = ${accountId}`;
}

async function ownsList(accountId: string, listId: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 AS ok FROM insights_keyword_lists WHERE id = ${listId} AND account_id = ${accountId}`;
  return Boolean(row);
}

export async function addKeywords(accountId: string, listId: string, keywords: string[]): Promise<void> {
  await ensureSchema();
  if (!(await ownsList(accountId, listId))) throw new Error("That list doesn't exist.");
  for (const k of [...new Set(keywords.map(normalizeKeyword).filter(Boolean))].slice(0, 500)) {
    await sql`
      INSERT INTO insights_tracked_keywords (list_id, keyword) VALUES (${listId}, ${k})
      ON CONFLICT DO NOTHING`;
  }
}

export async function removeKeyword(accountId: string, listId: string, keyword: string): Promise<void> {
  await ensureSchema();
  if (!(await ownsList(accountId, listId))) throw new Error("That list doesn't exist.");
  await sql`DELETE FROM insights_tracked_keywords WHERE list_id = ${listId} AND keyword = ${normalizeKeyword(keyword)}`;
}

// ---------- ranking tracker ----------

const WEEKS = 12;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Weekly Google position for each keyword over the last 12 weeks. */
export async function trackRankings(conn: Connection, keywords: string[]): Promise<Ranking[]> {
  const { auth, site } = requireSite(conn);
  const list = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))].slice(0, 200);
  if (!list.length) return [];

  const end = resolveRange("7d", 3).current.end;
  const start = toIso(new Date(Date.parse(`${end}T00:00:00Z`) - (WEEKS * 7 - 1) * 86_400_000));
  const filter = {
    dimensionFilterGroups: [
      { filters: [{ dimension: "query", operator: "includingRegex", expression: `^(${list.map(escapeRegex).join("|")})$` }] },
    ],
  };
  const [daily, pages] = await Promise.all([
    gscQuery(auth, site, { startDate: start, endDate: end, dimensions: ["query", "date"], rowLimit: 25000, ...filter }),
    gscQuery(auth, site, { startDate: start, endDate: end, dimensions: ["query", "page"], rowLimit: 5000, ...filter }),
  ]);

  const dates = listDates({ start, end });
  const weekOf = new Map(dates.map((d, i) => [d, Math.floor(i / 7)]));

  return list.map((keyword) => {
    const buckets = Array.from({ length: WEEKS }, (_, w) => ({ start: dates[w * 7], clicks: 0, impressions: 0, weighted: 0 }));
    for (const r of daily) {
      if (r.keys[0] !== keyword) continue;
      const b = buckets[weekOf.get(r.keys[1]) ?? -1];
      if (!b) continue;
      b.clicks += r.clicks;
      b.impressions += r.impressions;
      b.weighted += r.position * r.impressions;
    }
    const weeks: RankingWeek[] = buckets.map((b) => ({
      start: b.start,
      clicks: b.clicks,
      impressions: b.impressions,
      position: b.impressions ? Math.round((b.weighted / b.impressions) * 10) / 10 : null,
    }));
    const withData = weeks.filter((w) => w.position !== null);
    const latest = withData.at(-1)?.position ?? null;
    const earlier = weeks.slice(0, WEEKS - 4).filter((w) => w.position !== null).at(-1)?.position ?? null;
    const top = pages
      .filter((p) => p.keys[0] === keyword)
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)[0];
    return {
      keyword,
      weeks,
      position: latest,
      change: latest !== null && earlier !== null ? Math.round((earlier - latest) * 10) / 10 : null,
      clicks: weeks.reduce((s, w) => s + w.clicks, 0),
      impressions: weeks.reduce((s, w) => s + w.impressions, 0),
      topPage: top?.keys[1],
    };
  });
}
