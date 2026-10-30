import { ensureSchema, sql } from "../db";
import { keywordIdeas, keywordsReady } from "../keywords";
import { isPostUrl, sitePages } from "../site-crawl";

/**
 * Keywords for sites without Search Console. Search Console tells the
 * autopilot which searches a site already shows up for; without it, the app
 * works the other way round: for each important page, Keyword Planner
 * suggests what people search for that page's topic (with real monthly
 * volume), and the daily rank check finds where the site stands for those
 * searches on Google. Refreshed weekly; a few Keyword Planner calls each time.
 */

export interface SiteKeyword {
  keyword: string;
  monthlySearches: number;
  /** The page that should rank for it. */
  page: string;
}

const KEY = (accountId: string) => `sitekw:${accountId}`;
const WEEK = 7 * 86_400_000;
const PAGES_PER_REFRESH = 15;
const TARGETING = { geo: "2840", language: "1000" };

const STOP = new Set(
  "the and for with your you our are from that this what how why when best top guide review reviews home page about contact shop store blog news more".split(" ")
);
const topicWords = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
  );

/** Pages worth targeting: posts, products, services, and other content pages; not legal or utility pages. */
const worthTargeting = (url: string) =>
  !/\/(cart|checkout|account|login|search|tag|tags|author|category|categories|page\/\d|privacy|terms|refund|return|shipping|policy|policies|contact|cookie|accessibility|sitemap)(\/|$)/i.test(new URL(url).pathname);

/** True while keywords picked in the last 8 days exist, i.e. the site is still worked from Keyword Planner. */
export async function siteKeywordsActive(accountId: string): Promise<boolean> {
  await ensureSchema();
  const [row] = await sql`SELECT updated_at FROM insights_settings WHERE key = ${KEY(accountId)}`;
  return Boolean(row?.updated_at && Date.now() - new Date(row.updated_at).getTime() < WEEK + 86_400_000);
}

export async function readSiteKeywords(accountId: string): Promise<SiteKeyword[]> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`;
  return row?.value ? ((JSON.parse(row.value) as { items: SiteKeyword[] }).items ?? []) : [];
}

/** Finds (or refreshes, weekly) the keywords to aim each page at. Returns them, best first. */
export async function refreshSiteKeywords(accountId: string, brand: string): Promise<SiteKeyword[]> {
  await ensureSchema();
  const [row] = await sql`SELECT value, updated_at FROM insights_settings WHERE key = ${KEY(accountId)}`;
  if (row?.value && Date.now() - new Date(row.updated_at!).getTime() < WEEK) return readSiteKeywords(accountId);
  if (!(await keywordsReady().catch(() => false))) return readSiteKeywords(accountId);

  const pages = (await sitePages(accountId))
    .filter((p) => worthTargeting(p.url) && (p.h1 || p.title))
    // Blog posts and deeper pages first: they're where specific searches land.
    .sort((a, b) => Number(isPostUrl(b.url)) - Number(isPostUrl(a.url)) || b.text.length - a.text.length)
    .slice(0, PAGES_PER_REFRESH);

  const brandWord = brand.toLowerCase().split(/[^a-z0-9]+/)[0] ?? "";
  const found = new Map<string, SiteKeyword>();
  for (const p of pages) {
    const subject = (p.h1 || p.title).replace(/\s*[|·\-–—:]\s*[^|·\-–—:]{2,40}$/, "");
    const topic = topicWords(subject);
    if (!topic.size) continue;
    const ideas = await keywordIdeas({ ...TARGETING, keywords: [subject.slice(0, 80)], url: p.url }).catch(() => []);
    const fits = ideas
      .filter((i) => (i.avgMonthlySearches ?? 0) >= 20 && i.keyword.split(/\s+/).length <= 6)
      .filter((i) => !(brandWord && i.keyword.toLowerCase().includes(brandWord)))
      // On topic: shares at least half of its meaningful words with the page's subject.
      .filter((i) => {
        const w = [...topicWords(i.keyword)];
        return w.length > 0 && w.filter((x) => topic.has(x)).length / w.length >= 0.5;
      })
      // Easier and well searched first.
      .sort((a, b) => Number(a.competition === "HIGH") - Number(b.competition === "HIGH") || (b.avgMonthlySearches ?? 0) - (a.avgMonthlySearches ?? 0))
      .slice(0, 2);
    for (const i of fits) {
      const k = i.keyword.toLowerCase();
      if (!found.has(k)) found.set(k, { keyword: k, monthlySearches: i.avgMonthlySearches ?? 0, page: p.url });
    }
  }
  const items = [...found.values()].sort((a, b) => b.monthlySearches - a.monthlySearches).slice(0, 40);
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify({ items })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return items;
}
