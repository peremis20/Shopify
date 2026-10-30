import { ensureSchema, sql } from "../db";

/**
 * Website authority from Open PageRank (free, openpagerank.com): a score
 * from 0 to 10 for each domain, cached for 30 days. Used to judge whether
 * the sites on Google page one are beatable. The key comes from OPR_API_KEY
 * or the "opr_api_key" setting; without one the app falls back to its list
 * of big publishers.
 */

const CACHE_DAYS = 30;
/** At or above this score a site is a strong publisher, hard to outrank for a small site. */
export const STRONG_AUTHORITY = 5;

let storedKey: { value: string | null; at: number } | null = null;
async function oprKey(): Promise<string | null> {
  if (process.env.OPR_API_KEY) return process.env.OPR_API_KEY;
  if (storedKey && Date.now() - storedKey.at < 600_000) return storedKey.value;
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = 'opr_api_key'`.catch(() => [] as { value: string | null }[]);
  storedKey = { value: row?.value || null, at: Date.now() };
  return storedKey.value;
}

export const authorityReady = async () => Boolean(await oprKey().catch(() => null));

/** Authority (0 to 10) per domain; domains Open PageRank doesn't know are left out. */
export async function authorityOf(domains: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const key = await oprKey().catch(() => null);
  const list = [...new Set(domains.map((d) => d.toLowerCase().replace(/^www\./, "")).filter(Boolean))];
  if (!key || !list.length) return out;
  await ensureSchema();
  const cached = await sql`
    SELECT cache_key, data FROM insights_report_cache
    WHERE cache_key = ANY(${list.map((d) => `opr:${d}`)}) AND fetched_at > now() - make_interval(days => ${CACHE_DAYS})`;
  for (const r of cached) out.set(r.cache_key!.slice(4), Number(JSON.parse(r.data!).score));
  const missing = list.filter((d) => !out.has(d));
  // Up to 100 domains per request.
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const qs = batch.map((d) => `domains[]=${encodeURIComponent(d)}`).join("&");
    const res = await fetch(`https://openpagerank.com/api/v1.0/getPageRank?${qs}`, {
      headers: { "API-OPR": key },
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (!res?.ok) continue;
    const body = (await res.json().catch(() => ({}))) as { response?: { domain: string; page_rank_decimal: number | string; status_code: number }[] };
    for (const r of body.response ?? []) {
      if (r.status_code !== 200) continue;
      const score = Number(r.page_rank_decimal);
      if (!Number.isFinite(score)) continue;
      out.set(r.domain, score);
      await sql`
        INSERT INTO insights_report_cache (cache_key, data, fetched_at) VALUES (${`opr:${r.domain}`}, ${JSON.stringify({ score })}::jsonb, now())
        ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
    }
  }
  return out;
}
