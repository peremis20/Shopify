import crypto from "node:crypto";
import { ensureSchema, sql } from "../db";

/**
 * Google page one for a search, and what the pages beating us do differently.
 * Results come from a search results API (serper.dev), cached for a day.
 * Each lookup is also saved per account, so the next one can tell who moved
 * above us since.
 */

export interface SerpResult {
  position: number;
  title: string;
  link: string;
  domain: string;
  snippet: string;
}

export interface Serp {
  query: string;
  organic: SerpResult[];
  questions: string[];
  related: string[];
  /** Our best position on page one, or null when we're not on it. */
  ourPosition: number | null;
}

export interface CompetitorPage {
  position: number;
  domain: string;
  title: string;
  metaDescription: string;
  headings: string[];
  words: number;
  schemaTypes: string[];
}

export interface Competition {
  serp: Serp;
  competitors: CompetitorPage[];
  /** Domains that were below us (or off page one) last time and are above us now. */
  newlyAbove: string[];
}

const CACHE_HOURS = 24;
const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

async function fetchSerp(apiKey: string, query: string): Promise<Omit<Serp, "ourPosition">> {
  const cacheKey = `serp:${crypto.createHash("sha256").update(`us|en|${query.toLowerCase()}`).digest("hex")}`;
  await ensureSchema();
  const [row] = await sql`
    SELECT data FROM insights_report_cache
    WHERE cache_key = ${cacheKey} AND fetched_at > now() - make_interval(hours => ${CACHE_HOURS})`;
  if (row?.data) return JSON.parse(row.data);

  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, gl: "us", hl: "en", num: 10 }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Search results lookup failed: ${body?.message ?? res.status}`);
  const data = {
    query,
    organic: ((body.organic ?? []) as { position?: number; title?: string; link?: string; snippet?: string }[])
      .filter((r) => r.link)
      .slice(0, 10)
      .map((r, i) => ({ position: r.position ?? i + 1, title: r.title ?? "", link: r.link!, domain: domainOf(r.link!), snippet: r.snippet ?? "" })),
    questions: ((body.peopleAlsoAsk ?? []) as { question?: string }[]).map((q) => q.question ?? "").filter(Boolean).slice(0, 8),
    related: ((body.relatedSearches ?? []) as { query?: string }[]).map((q) => q.query ?? "").filter(Boolean).slice(0, 8),
  };
  await sql`
    INSERT INTO insights_report_cache (cache_key, data, fetched_at)
    VALUES (${cacheKey}, ${JSON.stringify(data)}::jsonb, now())
    ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
  return data;
}

// Sites whose pages are not ordinary articles we can learn from (or block plain fetches).
const SKIP_DOMAINS = /(^|\.)(amazon|reddit|youtube|wikipedia|facebook|instagram|pinterest|tiktok|quora|walmart|target|ebay|x|twitter)\.[a-z.]+$/;

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, " "));

/** Reads one competitor page: title, description, headings, length and structured data. */
async function readCompetitor(r: SerpResult): Promise<CompetitorPage | null> {
  const res = await fetch(r.link, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InsightsSEO/1.0)", Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!res?.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
  const html = (await res.text().catch(() => "")).slice(0, 2_000_000);
  if (!html) return null;

  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? r.title);
  const metaDescription = decode(
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ??
      ""
  );
  const headings = [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => `${m[1] === "1" ? "H1" : m[1] === "2" ? "H2" : "H3"}: ${stripTags(m[2])}`)
    .filter((h) => h.length > 4 && h.length < 160)
    .slice(0, 25);
  const schemaTypes = [
    ...new Set(
      [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((m) =>
        [...m[1].matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map((t) => t[1])
      )
    ),
  ].slice(0, 10);
  const main = html.match(/<(main|article)[\s\S]*?<\/\1>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  const text = stripTags(main.replace(/<(script|style|nav|header|footer|noscript)[\s\S]*?<\/\1>/gi, " "));
  return { position: r.position, domain: r.domain, title, metaDescription, headings, words: text.split(" ").length, schemaTypes };
}

/**
 * Page one for `query`, the top pages ranking above (or around) us, and who
 * passed us since the last check. `ourDomain` is the store's domain.
 */
export async function analyzeCompetition(
  apiKey: string,
  accountId: string,
  query: string,
  ourDomain: string
): Promise<Competition> {
  const base = await fetchSerp(apiKey, query);
  const ours = (d: string) => d === ourDomain || d.endsWith(`.${ourDomain}`);
  const ourPosition = base.organic.find((r) => ours(r.domain))?.position ?? null;
  const serp: Serp = { ...base, ourPosition };

  // Learn from the pages above us; when we're #1, from the ones right behind.
  const rivals = base.organic
    .filter((r) => !ours(r.domain) && !SKIP_DOMAINS.test(r.domain))
    .filter((r) => (ourPosition ? (ourPosition === 1 ? r.position <= 4 : r.position < ourPosition) : true))
    .slice(0, 3);
  const competitors = (await Promise.all(rivals.map((r) => readCompetitor(r).catch(() => null)))).filter(
    (c): c is CompetitorPage => Boolean(c)
  );

  const [last] = await sql`
    SELECT our_position, results FROM insights_serp_snapshots
    WHERE account_id = ${accountId} AND query = ${query} ORDER BY checked_at DESC LIMIT 1`;
  let newlyAbove: string[] = [];
  if (last?.results) {
    const before = JSON.parse(last.results) as SerpResult[];
    const lastOurs = last.our_position ? Number(last.our_position) : 11;
    const aboveBefore = new Set(before.filter((r) => r.position < lastOurs).map((r) => r.domain));
    newlyAbove = base.organic
      .filter((r) => !ours(r.domain) && r.position < (ourPosition ?? 11) && !aboveBefore.has(r.domain))
      .map((r) => r.domain);
  }
  await sql`
    INSERT INTO insights_serp_snapshots (account_id, query, our_position, results)
    VALUES (${accountId}, ${query}, ${ourPosition}, ${JSON.stringify(base.organic)}::jsonb)`.catch(() => undefined);

  return { serp, competitors, newlyAbove };
}

/** Quick check that the search results key works (uses one search credit). */
export async function checkSerpKey(apiKey: string): Promise<void> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: "shopify", num: 10 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`The search results key didn't work (${res.status}).`);
}
