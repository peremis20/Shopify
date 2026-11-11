import { ensureSchema, sql } from "../db";
import { readPlatformSettings } from "./settings";
import { report } from "./status";

/**
 * Keywords Everywhere (api.keywordseverywhere.com): real competitor data Google's own tools don't give.
 * - Domain keywords: the searches a rival site ranks for, with its position (2 credits per keyword).
 * - Unique domain backlinks: the sites that link to a rival, one link per site (5 credits per link).
 * - URL keywords: the searches one rival page ranks for (2 credits per keyword).
 * - Related keywords and "people also search for": more searches around a topic (2 credits per keyword).
 * - Keyword data: Keyword Planner volumes, CPC and a 12 month trend, used when Keyword Planner itself isn't working (1 credit per keyword).
 * - Domain traffic: a rival's estimated monthly Google visits (2 credits per domain).
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
async function call(path: string, params: Record<string, string | number | string[]>, cost: number): Promise<unknown[] | null> {
  const k = await keKey();
  if (!k) return null;
  const used = await creditsUsed();
  if (used + cost > k.limit) {
    await report("keywords-everywhere", false, `Monthly credit limit reached (${used} of ${k.limit} used).`);
    return null;
  }
  // Counted against the site being worked on (a site not yet proven to be the account's stays within its trial);
  // a reached limit is thrown, so the Inspector and the caller see it rather than an empty answer.
  const { spend, currentSite } = await import("./usage");
  if (currentSite()) await spend("search");
  const body = new URLSearchParams(
    Object.entries(params).flatMap(([a, b]) => (Array.isArray(b) ? b.map((v) => [`${a}[]`, v]) : [[a, String(b)]])),
  );
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
  const list = rankedKeywords(rows);
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

/** The searches one rival page ranks for in the US, most traffic first. */
export async function urlKeywords(url: string, num = 20): Promise<DomainKeyword[]> {
  if (!/^https?:\/\//.test(url)) return [];
  // The same page with tracking tags or a different anchor is one cache entry, so it is paid for once.
  let page = url;
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|srsltid)/i.test(k)) u.searchParams.delete(k);
    page = u.toString();
  } catch {
    return [];
  }
  const key = `ke:uk:${page}`;
  const hit = await cached<DomainKeyword[]>(key);
  if (hit) return hit;
  const rows = await call("get_url_keywords", { url: page, country: "us", num }, num * 2);
  if (!rows) return [];
  const list = rankedKeywords(rows);
  await store(key, list);
  return list;
}

/** Keyword rows (keyword, estimated traffic, position) in plain form, most traffic first. */
export function rankedKeywords(rows: unknown[]): DomainKeyword[] {
  return rows
    .map((r) => r as { keyword?: string; estimated_monthly_traffic?: number; serp_position?: number })
    .filter((r) => typeof r.keyword === "string" && r.keyword.trim())
    .map((r) => ({ keyword: String(r.keyword).trim().toLowerCase(), traffic: Number(r.estimated_monthly_traffic ?? 0) || 0, position: Number(r.serp_position ?? 0) || 0 }))
    .sort((a, b) => b.traffic - a.traffic);
}

async function keywordList(path: "get_related_keywords" | "get_pasf_keywords", tag: string, keyword: string, num: number): Promise<string[]> {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  const key = `ke:${tag}:${kw}`;
  const hit = await cached<string[]>(key);
  if (hit) return hit;
  const rows = await call(path, { keyword: kw, num }, num * 2);
  if (!rows) return [];
  const list = [...new Set(rows.filter((r): r is string => typeof r === "string").map((r) => r.trim().toLowerCase()).filter(Boolean))];
  await store(key, list);
  return list;
}

/** More searches around a topic. */
export const relatedKeywords = (keyword: string, num = 10) => keywordList("get_related_keywords", "rk", keyword, num);
/** What people search for next after a topic ("people also search for"). */
export const alsoSearched = (keyword: string, num = 10) => keywordList("get_pasf_keywords", "pasf", keyword, num);

export interface KeKeywordData {
  keyword: string;
  monthlySearches: number;
  cpc: number | null;
  competition: number | null;
  /** Last 12 months, oldest first. */
  trend: { month: string; searches: number }[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Keyword data rows in plain form; a missing trend stays empty, never guessed. */
export function keywordDataRows(rows: unknown[]): KeKeywordData[] {
  return rows
    .map((r) => r as { keyword?: string; vol?: number; cpc?: { value?: string }; competition?: number; trend?: { month?: string; year?: number; value?: number }[] })
    .filter((r) => typeof r.keyword === "string" && r.keyword.trim())
    .map((r) => {
      const cpc = r.cpc?.value != null && String(r.cpc.value).trim() !== "" ? Number(r.cpc.value) : NaN;
      return {
        keyword: String(r.keyword).trim().toLowerCase(),
        monthlySearches: Number(r.vol ?? 0) || 0,
        cpc: Number.isFinite(cpc) ? cpc : null,
        competition: typeof r.competition === "number" ? r.competition : null,
        trend: (r.trend ?? [])
          .filter((t) => t.month && t.year && MONTHS.includes(t.month))
          .map((t) => ({ month: `${t.year}-${String(MONTHS.indexOf(t.month!) + 1).padStart(2, "0")}`, searches: Number(t.value ?? 0) || 0 }))
          .sort((a, b) => a.month.localeCompare(b.month)),
      };
    });
}

/**
 * Keyword Planner numbers through Keywords Everywhere, for up to 100 searches (US, USD). Each search is kept in the
 * shared cache, since monthly volumes are public facts, so a search is only paid for once a month.
 */
export async function keywordData(keywords: string[]): Promise<KeKeywordData[]> {
  const list = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, 100);
  if (!list.length) return [];
  const out: KeKeywordData[] = [];
  const missing: string[] = [];
  for (const k of list) {
    const hit = await cached<KeKeywordData>(`ke:kd:${k}`);
    if (hit) out.push(hit);
    else missing.push(k);
  }
  if (missing.length) {
    const rows = await call("get_keyword_data", { kw: missing, country: "us", currency: "usd", dataSource: "gkp" }, missing.length);
    for (const d of keywordDataRows(rows ?? [])) {
      out.push(d);
      await store(`ke:kd:${d.keyword}`, d);
    }
  }
  return out;
}

/** A rival domain's estimated monthly Google visits (US) and how many searches it ranks for in the top 30. */
export async function domainTraffic(domain: string): Promise<{ traffic: number; keywords: number } | null> {
  const d = clean(domain);
  const key = `ke:dt:${d}`;
  const hit = await cached<{ traffic: number; keywords: number }>(key);
  if (hit) return hit;
  const rows = await call("get_domain_traffic_metrics", { domains: [d], country: "us" }, 2);
  const r = rows?.[0] as { estimated_monthly_traffic?: number; total_ranking_keywords?: number } | undefined;
  if (!r) return null;
  const out = { traffic: Number(r.estimated_monthly_traffic ?? 0) || 0, keywords: Number(r.total_ranking_keywords ?? 0) || 0 };
  await store(key, out);
  return out;
}

/** Credits left on the Keywords Everywhere plan (free to ask), or null when there's no key or it can't be read. */
let leftCache: { at: number; n: number | null } | null = null;
export async function creditsLeft(): Promise<number | null> {
  // Asked at most every 10 minutes, so the settings page stays quick.
  if (leftCache && Date.now() - leftCache.at < 10 * 60_000) return leftCache.n;
  const n = await readCreditsLeft();
  leftCache = { at: Date.now(), n };
  return n;
}

async function readCreditsLeft(): Promise<number | null> {
  const k = await keKey();
  if (!k) return null;
  const res = await fetch(`${API}/account/credits`, {
    headers: { Authorization: `Bearer ${k.key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (!res?.ok) {
    console.warn(`keywords everywhere credits check failed: ${res ? res.status : "no answer"}`);
    return null;
  }
  const body = (await res.json().catch(() => null)) as unknown;
  const n = Array.isArray(body) ? Number(body[0]) : Number((body as { credits?: number } | null)?.credits);
  return Number.isFinite(n) ? n : null;
}

/** Credits DashPatrol has spent this month, against its own monthly limit. */
export async function creditsSpent(): Promise<number> {
  return creditsUsed();
}
