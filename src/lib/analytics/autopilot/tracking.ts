import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { toIso } from "../dates";
import { googleRequest } from "../google-auth";
import { getLists, THIN_GSC } from "../seo-tools";
import { fetchSerp } from "./serp";
import { isJunkKeyword } from "./keyword-guard";
import { readSiteKeywords } from "./site-keywords";

/**
 * Daily rank tracking. Search Console lags about 3 days; this checks Google
 * page one every day for the searches that matter most, so a drop can be
 * defended the next morning. Uses one search results credit per search per
 * day (results are cached for a day and shared between accounts).
 */

export const TRACK_PER_DAY = 15;

export interface RankWatchRow {
  query: string;
  /** Today's (or the latest) position on page one, null when off page one. */
  position: number | null;
  previous: number | null;
  /** Best position in the last 7 days. */
  best7: number | null;
  url: string | null;
  checkedOn: string;
  history: { day: string; position: number | null }[];
}

const DAY = 86_400_000;
const isOurs = (domain: string, ourDomain: string) => domain === ourDomain || domain.endsWith(`.${ourDomain}`);

/**
 * Long, chat style questions ("help me pick out a simple, effective ...") come
 * from AI search and never appear as ordinary Google results, so they aren't
 * worth a daily check.
 */
const isKeyword = (q: string) => q.split(/\s+/).length <= 6 && !/[?.!,]$/.test(q.trim()) && !/^(help me|can you|tell me|show me|i need|i want)\b/i.test(q);
/** Picked by the app (not the owner): also has to pass the keyword guardrail. */
const isGoodPick = (q: string) => isKeyword(q) && !isJunkKeyword(q);

/**
 * In order: saved keywords, the searches the autopilot is working on, then the
 * page one and page two searches with the most impressions (no brand searches).
 */
async function queriesToTrack(accountId: string, conn: Connection, ourDomain: string): Promise<string[]> {
  const saved = (await getLists(accountId).catch(() => [])).flatMap((l) => l.keywords);
  const targets = (
    await sql`SELECT query, max(created_at) AS at FROM insights_autopilot_changes
      WHERE account_id = ${accountId} AND field <> 'intent' AND created_at > now() - interval '120 days'
      GROUP BY query ORDER BY at DESC LIMIT 10`
  ).map((r) => r.query!);
  // Without Search Console: the keywords picked for each page (see site-keywords.ts).
  if (!conn.gscSiteUrl) {
    const picked = (await readSiteKeywords(accountId).catch(() => [])).map((k) => k.keyword);
    // More than a day's checks: they take turns (see trackRanks).
    return [...new Set([...saved.slice(0, 5), ...targets, ...picked].map((q) => q.trim().toLowerCase()))].slice(0, 40);
  }
  const end = new Date(Date.now() - 3 * DAY);
  const body = await googleRequest<{ rows?: { keys: string[]; clicks: number; impressions: number; position: number }[] }>(
    { kind: "oauth", refreshToken: conn.refreshToken },
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(conn.gscSiteUrl!)}/searchAnalytics/query`,
    { startDate: toIso(new Date(end.getTime() - 27 * DAY)), endDate: toIso(end), dimensions: ["query"], rowLimit: 500 }
  ).catch(() => ({ rows: [] }));
  const brand = ourDomain.split(".")[0];
  const searches = (body.rows ?? [])
    .filter((r) => r.position <= 20 && r.impressions >= 5 && isGoodPick(r.keys[0]) && !(brand && r.keys[0].includes(brand)))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .map((r) => r.keys[0]);
  // Search Console new or thin: the Keyword Planner picks fill the rest, taking turns like above.
  if (searches.length < THIN_GSC) {
    const picked = (await readSiteKeywords(accountId).catch(() => [])).map((k) => k.keyword);
    return [...new Set([...saved.slice(0, 5), ...targets, ...searches, ...picked].map((q) => q.trim().toLowerCase()))].slice(0, 40);
  }
  return [...new Set([...saved.slice(0, 5), ...targets, ...searches].map((q) => q.trim().toLowerCase()))].slice(0, TRACK_PER_DAY);
}

/** Checks today's Google positions once a day. Returns how many searches were checked. */
export async function trackRanks(accountId: string, conn: Connection, serpKey: string, ourDomain: string): Promise<number> {
  await ensureSchema();
  const today = toIso(new Date());
  const doneToday = new Set(
    (await sql`SELECT query FROM insights_rank_daily WHERE account_id = ${accountId} AND checked_on = ${today}`).map((r) => r.query!)
  );
  if (doneToday.size >= TRACK_PER_DAY) return 0;
  // Only searches not checked yet today, so a second run the same day costs nothing extra.
  const lastChecked = new Map(
    (await sql`SELECT query, max(checked_on) AS last FROM insights_rank_daily WHERE account_id = ${accountId} GROUP BY query`).map((r) => [r.query!, r.last!])
  );
  // Never checked first, then the longest unchecked, within what's left of today's checks.
  const queries = (await queriesToTrack(accountId, conn, ourDomain))
    .filter((q) => !doneToday.has(q))
    .map((q, i) => ({ q, i, last: lastChecked.get(q) ?? "" }))
    .sort((a, b) => a.last.localeCompare(b.last) || a.i - b.i)
    .slice(0, TRACK_PER_DAY - doneToday.size)
    .map((x) => x.q);
  let checked = 0;
  // A few at a time, to stay friendly with the search results API.
  for (let i = 0; i < queries.length; i += 5) {
    await Promise.all(
      queries.slice(i, i + 5).map(async (q) => {
        const serp = await fetchSerp(serpKey, q).catch(() => null);
        if (!serp) return;
        const ours = serp.organic.find((r) => isOurs(r.domain, ourDomain));
        await sql`
          INSERT INTO insights_rank_daily (account_id, query, checked_on, position, url)
          VALUES (${accountId}, ${q}, ${today}, ${ours?.position ?? null}, ${ours?.link ?? null})
          ON CONFLICT (account_id, query, checked_on) DO UPDATE SET position = EXCLUDED.position, url = EXCLUDED.url`;
        checked++;
      })
    );
  }
  return checked;
}

/** The last 14 days of daily positions per tracked search, latest first by importance. */
export async function rankWatch(accountId: string): Promise<RankWatchRow[]> {
  await ensureSchema();
  const since = toIso(new Date(Date.now() - 14 * DAY));
  const rows = await sql`
    SELECT query, checked_on, position, url FROM insights_rank_daily
    WHERE account_id = ${accountId} AND checked_on >= ${since} ORDER BY query, checked_on`;
  const byQuery = new Map<string, { day: string; position: number | null; url: string | null }[]>();
  for (const r of rows) {
    const list = byQuery.get(r.query!) ?? [];
    list.push({ day: r.checked_on!.slice(0, 10), position: r.position === null ? null : Number(r.position), url: r.url });
    byQuery.set(r.query!, list);
  }
  const weekAgo = toIso(new Date(Date.now() - 7 * DAY));
  // Junk the app picked before the guardrail drops out; searches the owner saved always stay.
  const saved = new Set((await getLists(accountId).catch(() => [])).flatMap((l) => l.keywords));
  const out: RankWatchRow[] = [];
  for (const [query, hist] of byQuery) {
    if (!isKeyword(query) || (isJunkKeyword(query) && !saved.has(query))) continue;
    const last = hist.at(-1)!;
    const prev = hist.at(-2);
    const week = hist.filter((h) => h.day >= weekAgo && h.position !== null).map((h) => h.position!);
    out.push({
      query,
      position: last.position,
      previous: prev?.position ?? null,
      best7: week.length ? Math.min(...week) : null,
      url: last.url ?? [...hist].reverse().find((h) => h.url)?.url ?? null,
      checkedOn: last.day,
      history: hist.map(({ day, position }) => ({ day, position })),
    });
  }
  return out.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
}

/** Accounts with the autopilot on that haven't had today's rank check. */
export async function accountsDueForTracking(limit: number): Promise<string[]> {
  await ensureSchema();
  const today = toIso(new Date());
  // Fewer checks than the daily allowance means some may still be due (finding none costs one Search Console call).
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    WHERE a.enabled AND (
      SELECT count(*) FROM insights_rank_daily r WHERE r.account_id = a.account_id AND r.checked_on = ${today}) < ${TRACK_PER_DAY}
    LIMIT ${limit}`;
  return rows.map((r) => r.account_id!);
}
