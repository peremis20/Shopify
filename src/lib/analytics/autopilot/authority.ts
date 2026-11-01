import { ensureSchema, sql } from "../db";
import { readPlatformSettings } from "./settings";

/**
 * Website authority from Open PageRank (free, openpagerank.com): a score
 * from 0 to 10 for each domain, cached for 30 days. Used to judge whether
 * the sites on Google page one are beatable. The key is one of the platform
 * keys in Autopilot settings (or OPR_API_KEY); without one the app falls
 * back to its list of big publishers.
 */

const CACHE_DAYS = 30;
/** At or above this score a site is a strong publisher, hard to outrank for a small site. */
export const STRONG_AUTHORITY = 5;

let storedKey: { value: string | null; at: number } | null = null;
/** The key from the platform keys in Autopilot settings (or OPR_API_KEY), cached for ten minutes. */
async function oprKey(): Promise<string | null> {
  if (process.env.OPR_API_KEY) return process.env.OPR_API_KEY;
  if (storedKey && Date.now() - storedKey.at < 600_000) return storedKey.value;
  const platform = await readPlatformSettings().catch(() => null);
  let value = platform?.oprKey ?? null;
  if (!value) {
    await ensureSchema();
    const [row] = await sql`SELECT value FROM insights_settings WHERE key = 'opr_api_key'`.catch(() => [] as { value: string | null }[]);
    value = row?.value || null;
  }
  storedKey = { value, at: Date.now() };
  return value;
}

export const authorityReady = async () => Boolean(await oprKey().catch(() => null));

/** Authority (0 to 10) per domain; domains Open PageRank doesn't know are left out. */
export async function authorityOf(domains: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const key = await oprKey().catch(() => null);
  const list = [...new Set(domains.map((d) => d.toLowerCase().replace(/^www\./, "")).filter(Boolean))];
  if (!key || !list.length) return out;
  await ensureSchema();
  // Values go over the wire as text, so the list is sent joined and split in Postgres.
  const cached = await sql`
    SELECT cache_key, data FROM insights_report_cache
    WHERE cache_key = ANY(string_to_array(${list.map((d) => `opr:${d}`).join(",")}, ',')) AND fetched_at > now() - make_interval(days => ${CACHE_DAYS})`;
  for (const r of cached) out.set(r.cache_key!.slice(4), Number(JSON.parse(r.data!).score));
  const missing = list.filter((d) => !out.has(d));
  // Up to 100 domains per request.
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const qs = batch.map((d) => `domains[]=${encodeURIComponent(d)}`).join("&");
    const res = await fetch(`https://openpagerank.com/api/v1.0/getPageRank?${qs}`, {
      headers: { "API-OPR": key },
      signal: AbortSignal.timeout(15000),
    }).catch((e) => (console.warn(`openpagerank request failed: ${(e as Error).message}`), null));
    if (!res?.ok) {
      if (res) console.warn(`openpagerank ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      continue;
    }
    const raw = await res.text().catch(() => "");
    let body: { response?: { domain: string; page_rank_decimal: number | string; status_code: number }[] } = {};
    try {
      body = JSON.parse(raw);
    } catch {
      console.warn(`openpagerank sent something that isn't JSON: ${raw.slice(0, 300)}`);
    }
    if (!(body.response ?? []).some((r) => r.status_code === 200)) console.warn(`openpagerank returned no scores: ${raw.slice(0, 300)}`);
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

/* Your score over time: one reading a day, kept for about a year. */

export interface AuthorityReading { day: string; score: number }
const HISTORY_KEY = (accountId: string) => `opr_history:${accountId}`;

export async function readAuthorityHistory(accountId: string): Promise<AuthorityReading[]> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${HISTORY_KEY(accountId)}`;
  return row?.value ? (JSON.parse(row.value) as AuthorityReading[]) : [];
}

export async function recordAuthority(accountId: string, score: number): Promise<AuthorityReading[]> {
  const day = new Date().toISOString().slice(0, 10);
  const all = (await readAuthorityHistory(accountId)).filter((r) => r.day !== day);
  const next = [...all, { day, score }].sort((a, b) => a.day.localeCompare(b.day)).slice(-400);
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${HISTORY_KEY(accountId)}, ${JSON.stringify(next)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return next;
}

/* The sites that keep beating you: who ranks above you on your target searches, with their strength. */

export interface Rival { domain: string; authority: number | null; beats: number; searches: string[] }
const RIVALS_HOURS = 24;

export async function rivals(
  accountId: string,
  keywords: string[],
  ourDomain: string,
  fetchSerp: (query: string) => Promise<{ organic: { position: number; domain: string }[] }>
): Promise<Rival[]> {
  await ensureSchema();
  const cacheKey = `rivals:${accountId}`;
  const [hit] = await sql`
    SELECT data FROM insights_report_cache
    WHERE cache_key = ${cacheKey} AND fetched_at > now() - make_interval(hours => ${RIVALS_HOURS})`;
  if (hit?.data) return JSON.parse(hit.data) as Rival[];

  const ours = ourDomain.toLowerCase().replace(/^www\./, "");
  const isOurs = (d: string) => {
    const x = d.toLowerCase().replace(/^www\./, "");
    return x === ours || x.endsWith(`.${ours}`);
  };
  const tally = new Map<string, { beats: number; searches: string[] }>();
  for (const k of [...new Set(keywords)].slice(0, 10)) {
    const serp = await fetchSerp(k).catch(() => null);
    if (!serp) continue;
    const top = serp.organic.slice(0, 10);
    const our = top.find((r) => isOurs(r.domain))?.position ?? Infinity;
    for (const r of top) {
      if (isOurs(r.domain) || r.position >= our) continue;
      const d = r.domain.toLowerCase().replace(/^www\./, "");
      const t = tally.get(d) ?? { beats: 0, searches: [] };
      t.beats++;
      if (t.searches.length < 3) t.searches.push(k);
      tally.set(d, t);
    }
  }
  const best = [...tally.entries()].sort((a, b) => b[1].beats - a[1].beats).slice(0, 6);
  const scores = await authorityOf(best.map(([d]) => d)).catch(() => new Map<string, number>());
  const out: Rival[] = best.map(([domain, t]) => ({ domain, authority: scores.get(domain) ?? null, ...t }));
  if (out.length) {
    await sql`
      INSERT INTO insights_report_cache (cache_key, data, fetched_at) VALUES (${cacheKey}, ${JSON.stringify(out)}::jsonb, now())
      ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
  }
  return out;
}
