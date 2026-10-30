import { ensureSchema, sql } from "../db";
import type { KeywordIdea } from "../keyword-options";
import { keywordIdeas, keywordsReady, keywordVolumes } from "../keywords";
import { isPostUrl, sitePages } from "../site-crawl";
import { allowsFaith, readProfile } from "../profile";
import { isJunkKeyword } from "./keyword-guard";
import { fetchSerp, type SerpResult } from "./serp";

/**
 * Keywords for sites without Search Console. Search Console tells the
 * autopilot which searches a site already shows up for; without it, the app
 * works the other way round: for each important page, Keyword Planner
 * suggests what people search for that page's topic (with real monthly
 * volume), and the daily rank check finds where the site stands for those
 * searches on Google. Refreshed weekly; a few Keyword Planner calls each time.
 *
 * With a search results key it also studies the competition, the way an SEO
 * would: for each page it looks at who's on Google page one for the page's
 * topic, asks Keyword Planner what those competitor pages rank for, adds
 * Google's related searches, then checks page one for the best candidates and
 * keeps the ones a site like this can win (small sites already rank there,
 * not only the big health publishers).
 */

export interface SiteKeyword {
  keyword: string;
  monthlySearches: number;
  /** The page that should rank for it. */
  page: string;
  /** Why it was picked, in a few words (shown in Opportunities). */
  why?: string;
  /** Page one has room: smaller sites rank there, so this site can too. */
  winnable?: boolean;
  /**
   * "main": a specific, long tail search the page aims to rank for first.
   * "support": a broad search (short or very high volume) used naturally in
   * the content to back up the main ones, not chased on its own.
   */
  role?: "main" | "support";
}

const KEY = (accountId: string) => `sitekw:${accountId}`;
const WEEK = 7 * 86_400_000;
const PAGES_PER_REFRESH = 15;
const TARGETING = { geo: "2840", language: "1000" };
/** Page one checks per refresh (search results API credits). */
const SERP_CHECKS = 20;

/** Big publishers and marketplaces: hard to outrank for a small site. */
const BIG =
  /(^|\.)(healthline|webmd|mayoclinic|clevelandclinic|medicalnewstoday|verywellhealth|verywellmind|verywellfit|hopkinsmedicine|health\.harvard|everydayhealth|health|prevention|menshealth|womenshealth|eatingwell|forbes|nytimes|amazon|walmart|target|wikipedia|youtube|reddit|quora|pinterest|facebook|instagram|tiktok|cdc|nih|ncbi\.nlm\.nih|medlineplus|fda)\.(com|org|gov|edu|net)$|\.gov$|\.edu$/;
export const isBig = (domain: string) => BIG.test(domain);

/** How many page one results are smaller sites, and whether this site is already there. */
export function room(results: SerpResult[], ourDomain: string): { small: number; ours: number | null } {
  const top = results.slice(0, 10);
  const ours = top.find((r) => r.domain === ourDomain || r.domain.endsWith(`.${ourDomain}`))?.position ?? null;
  return { small: top.filter((r) => !isBig(r.domain)).length, ours };
}

const STOP = new Set(
  "the and for with your you our are from that this what how why when best top guide review reviews home page about contact shop store blog news more".split(" ")
);
export const topicWords = (s: string) =>
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
/** Above this many searches a month a search is broad, whatever its length. */
export const BROAD_VOLUME = 20_000;

/**
 * Specific searches (three words or more, not huge volume) are where a site
 * starts ranking: less competition and clearer intent. Broad ones back them up.
 */
export const isLongTail = (keyword: string, monthlySearches: number) =>
  keyword.trim().split(/\s+/).length >= 3 && monthlySearches <= BROAD_VOLUME;

/** Main targets per page, and broad searches kept to support them. */
const MAIN_PER_PAGE = 3;
const SUPPORT_PER_PAGE = 2;

export async function siteKeywordsActive(accountId: string): Promise<boolean> {
  await ensureSchema();
  const [row] = await sql`SELECT updated_at FROM insights_settings WHERE key = ${KEY(accountId)}`;
  // Two weeks: the list is rebuilt weekly, and a late rebuild shouldn't switch the app off in between.
  return Boolean(row?.updated_at && Date.now() - new Date(row.updated_at).getTime() < 2 * WEEK);
}

/** Broad searches that back up a page's main targets, for the writer. */
export async function supportFor(accountId: string, page: string): Promise<string[]> {
  return (await readSiteKeywords(accountId)).filter((k) => k.role === "support" && k.page === page).map((k) => k.keyword);
}

/** Faith topics count as on topic for a faith and health publication. */
export const faithAllowed = async (accountId: string) => allowsFaith((await readProfile(accountId).catch(() => null))?.businessType);

export async function readSiteKeywords(accountId: string): Promise<SiteKeyword[]> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`;
  // Older lists were picked before the guardrail: junk is left out when read too.
  if (!row?.value) return [];
  const faith = await faithAllowed(accountId);
  return ((JSON.parse(row.value) as { items: SiteKeyword[] }).items ?? []).filter((k) => !isJunkKeyword(k.keyword, { faith }));
}

/** Finds (or refreshes, weekly) the keywords to aim each page at. Returns them, best first. */
export async function refreshSiteKeywords(accountId: string, brand: string, serperKey?: string | null, ourDomain = ""): Promise<SiteKeyword[]> {
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
  const faith = await faithAllowed(accountId);
  const found = new Map<string, SiteKeyword>();
  for (const p of pages) {
    const subject = (p.h1 || p.title).replace(/\s*[|·\-–—:]\s*[^|·\-–—:]{2,40}$/, "");
    const topic = topicWords(subject);
    if (!topic.size) continue;
    const ideas: KeywordIdea[] = await keywordIdeas({ ...TARGETING, keywords: [subject.slice(0, 80)], url: p.url }).catch(() => []);
    let rival = "";
    if (serperKey) {
      // Who's on page one for this page's topic, and what the best smaller competitor ranks for.
      const serp = await fetchSerp(serperKey, subject.slice(0, 80).toLowerCase()).catch(() => null);
      const comp = serp?.organic.find((r) => r.domain !== ourDomain && !isBig(r.domain));
      if (comp) {
        rival = comp.domain;
        ideas.push(...(await keywordIdeas({ ...TARGETING, keywords: [], url: comp.link }).catch(() => [])));
      }
      // Google's own related searches, with their volume.
      if (serp?.related.length) ideas.push(...(await keywordVolumes({ ...TARGETING, keywords: serp.related }).catch(() => [])));
    }
    const onTopic = ideas
      .filter((i) => (i.avgMonthlySearches ?? 0) >= 20 && i.keyword.split(/\s+/).length <= 7)
      .filter((i) => !(brandWord && i.keyword.toLowerCase().includes(brandWord)))
      // Guardrail: no stuttered, local, navigational or off topic searches.
      .filter((i) => !isJunkKeyword(i.keyword, { faith }))
      // On topic: shares at least half of its meaningful words with the page's subject.
      .filter((i) => {
        const w = [...topicWords(i.keyword)];
        return w.length > 0 && w.filter((x) => topic.has(x)).length / w.length >= 0.5;
      })
      // Easier and well searched first.
      .sort((a, b) => Number(a.competition === "HIGH") - Number(b.competition === "HIGH") || (b.avgMonthlySearches ?? 0) - (a.avgMonthlySearches ?? 0));
    // Long tail searches are what the page aims at; a couple of broad ones support them.
    const main = onTopic.filter((i) => isLongTail(i.keyword, i.avgMonthlySearches ?? 0)).slice(0, serperKey ? MAIN_PER_PAGE : 2);
    const support = onTopic.filter((i) => !isLongTail(i.keyword, i.avgMonthlySearches ?? 0)).slice(0, SUPPORT_PER_PAGE);
    for (const [list, role] of [[main, "main"], [support, "support"]] as const) {
      for (const i of list) {
        const k = i.keyword.toLowerCase();
        if (!found.has(k))
          found.set(k, { keyword: k, monthlySearches: i.avgMonthlySearches ?? 0, page: p.url, role, why: rival ? `${rival} ranks for it` : undefined });
      }
    }
  }
  let items = [...found.values()].sort((a, b) => b.monthlySearches - a.monthlySearches);
  if (serperKey) {
    // Look at page one for the main targets: keep the ones with room for a site like this.
    for (const k of items.filter((i) => i.role === "main").slice(0, SERP_CHECKS)) {
      const serp = await fetchSerp(serperKey, k.keyword).catch(() => null);
      if (!serp) continue;
      const { small, ours } = room(serp.organic, ourDomain);
      k.winnable = ours !== null || small >= 3;
      k.why =
        ours !== null
          ? `You're #${ours}; ${small} smaller sites on page 1`
          : small >= 3
            ? `${small} smaller sites on page 1${k.why ? `, ${k.why}` : ""}`
            : "Page 1 is mostly big health sites";
    }
  }
  // Main targets first (winnable, then by searches), then the broad ones that support them.
  items = items.filter((k) => !isJunkKeyword(k.keyword, { faith }));
  const rank = (k: SiteKeyword) => (k.role === "support" ? 2 : k.winnable === false ? 1 : 0);
  items.sort((a, b) => rank(a) - rank(b) || Number(b.winnable ?? false) - Number(a.winnable ?? false) || b.monthlySearches - a.monthlySearches);
  items = items.slice(0, 50);
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify({ items })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return items;
}
