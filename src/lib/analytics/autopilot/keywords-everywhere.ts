import { ensureSchema, sql } from "../db";
import { readPlatformSettings } from "./settings";
import { report } from "./status";

/**
 * Keywords Everywhere (api.keywordseverywhere.com): real competitor data Google's own tools don't give.
 * - Domain keywords: the searches a rival site ranks for, with its position (2 credits per keyword).
 * - Unique domain backlinks: the sites that link to a rival, one link per site (5 credits per link).
 * Both are public facts about a public site, so they sit in the shared cache for 30 days, and they are only ever asked
 * about rivals that aren't other customers (the callers filter those out first). Credits are capped each month.
 */

const API = "https://api.keywordseverywhere.com/v1";
const CACHE_DAYS = 30;
/** Credits the platform may spend a month when the owner set no limit. */
export const DEFAULT_MONTHLY_CREDITS = 3000;

export interface DomainKeyword {
  keyword: string;
  /** Visits a month the rival gets from this search, as Keywords Everywhere estimates it. */
  traffic: number;
  position: number;
}

export interface Backlink {
  sourceUrl: string;
  sourceDomain: string;
  targetUrl: string;
  anchor: string;
}

const monthKey = () => `ke_credits:${new Date().toISOString().slice(0, 7)}`;

async function creditsUsed(): Promise<number> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${monthKey()}`.catch(() => [] as { value: string | null }[]);
  return Number(row?.value ?? 0) || 0;
}

async function addCredits(credits: number): Promise<void> {
  const n = Math.ceil(credits);
  if (!(n > 0)) return;
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${monthKey()}, ${String(n)})
    ON CONFLICT (key) DO UPDATE SET value = (COALESCE(NULLIF(insights_settings.value, '')::int, 0) + ${n})::text, updated_at = now()`.catch(
    // Spending that isn't counted could pass the monthly limit: the Inspector must see it.
    (e) => report("keywords-everywhere", false, `Credits used couldn't be counted: ${(e as Error).message}`),
  );
}

async function keKey(): Promise<{ key: string; limit: number } | null> {
  const p = await readPlatformSettings().catch(() => null);
  if (!p?.keKey) return null;
  return { key: p.keKey, limit: p.keMonthlyCredits ?? DEFAULT_MONTHLY_CREDITS };
}

export const keReady = async () => Boolean(await keKey());

/** A plain sentence for a failed call, in Keywords Everywhere's own words where it gave some. */
async function failure(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  let msg = body.slice(0, 200);
  try {
    const j = JSON.parse(body) as { message?: string; description?: string };
    msg = [j.message, j.description].filter(Boolean).join(": ") || msg;
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return "Keywords Everywhere didn't accept the API key. Copy it again from your Keywords Everywhere account into Platform keys.";
  if (res.status === 402) return `Keywords Everywhere has no credits left on this plan (${msg}). Add credits in your Keywords Everywhere account.`;
  return `Keywords Everywhere answered ${res.status}${msg ? `: ${msg}` : ""}.`;
}

/** Tried when the key is saved: the credit balance, which costs nothing. Throws a plain sentence when it fails. */
export async function checkKeKey(key: string): Promise<number> {
  const res = await fetch(`${API}/account/credits`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res) {
    const why = "Keywords Everywhere couldn't be reached to test the key. It will be tried again on the next save or check.";
    await report("keywords-everywhere", false, why);
    throw new Error(why);
  }
  if (!res.ok) {
    const why = await failure(res);
    await report("keywords-everywhere", false, why);
    throw new Error(why);
  }
  const body = (await res.json().catch(() => null)) as unknown;
  const balance = Array.isArray(body) ? Number(body[0]) : Number((body as { credits?: number } | null)?.credits);
  await report("keywords-everywhere", true);
  return Number.isFinite(balance) ? balance : 0;
}

async function cached<T>(key: string): Promise<T | null> {
  const [row] = await sql`
    SELECT data FROM insights_report_cache WHERE cache_key = ${key} AND fetched_at > now() - make_interval(days => ${CACHE_DAYS})`.catch(() => [] as { data: string | null }[]);
  if (!row?.data) return null;
  try {
    return (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as T;
  } catch {
    return null;
  }
}

async function store(key: string, data: unknown): Promise<void> {
  await sql`
    INSERT INTO insights_report_cache (cache_key, data, fetched_at) VALUES (${key}, ${JSON.stringify(data)}::jsonb, now())
    ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
}

/**
 * One paid call, within the monthly credit limit. `cost` is the most it can spend; returns null (and says why on the
 * status board) when the key is missing, the limit is reached or the call fails, so callers carry on without it.
 */
async function call(path: string, params: Record<string, string | number>, cost: number): Promise<unknown[] | null> {
  const k = await keKey();
  if (!k) return null;
  const used = await creditsUsed();
  if (used + cost > k.limit) {
    await report("keywords-everywhere", false, `Monthly credit limit reached (${used} of ${k.limit} used).`);
    return null;
  }
  const body = new URLSearchParams(Object.entries(params).map(([a, b]) => [a, String(b)]));
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${k.key}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30000),
  }).catch((e) => (console.warn(`keywords everywhere ${path} failed: ${(e as Error).message}`), null));
  if (!res) return null;
  if (!res.ok) {
    await report("keywords-everywhere", false, await failure(res));
    return null;
  }
  const json = (await res.json().catch(() => null)) as { data?: unknown[]; credits_consumed?: number } | null;
  await addCredits(Number(json?.credits_consumed ?? cost));
  await report("keywords-everywhere", true);
  return Array.isArray(json?.data) ? json.data : [];
}

const clean = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/** The searches a rival domain ranks for in the US, most traffic first. */
export async function domainKeywords(domain: string, num = 30): Promise<DomainKeyword[]> {
  const d = clean(domain);
  const key = `ke:dk:${d}`;
  const hit = await cached<DomainKeyword[]>(key);
  if (hit) return hit;
  const rows = await call("get_domain_keywords", { domain: d, country: "us", num }, num * 2);
  if (!rows) return [];
  const list = rows
    .map((r) => r as { keyword?: string; estimated_monthly_traffic?: number; serp_position?: number })
    .filter((r) => typeof r.keyword === "string" && r.keyword.trim())
    .map((r) => ({ keyword: String(r.keyword).trim().toLowerCase(), traffic: Number(r.estimated_monthly_traffic ?? 0) || 0, position: Number(r.serp_position ?? 0) || 0 }))
    .sort((a, b) => b.traffic - a.traffic);
  await store(key, list);
  return list;
}

/** The sites that link to a rival domain, one link per site. */
export async function rivalBacklinks(domain: string, num = 15): Promise<Backlink[]> {
  const d = clean(domain);
  const key = `ke:bl:${d}`;
  const hit = await cached<Backlink[]>(key);
  if (hit) return hit;
  const rows = await call("get_unique_domain_backlinks", { domain: d, num }, num * 5);
  if (!rows) return [];
  const list = rows
    .map((r) => r as { anchor_text?: string; domain_source?: string; url_source?: string; url_target?: string })
    .filter((r) => typeof r.url_source === "string" && /^https?:\/\//.test(r.url_source) && r.domain_source)
    .map((r) => ({ sourceUrl: String(r.url_source), sourceDomain: clean(String(r.domain_source)), targetUrl: String(r.url_target ?? ""), anchor: String(r.anchor_text ?? "").slice(0, 120) }));
  await store(key, list);
  return list;
}
