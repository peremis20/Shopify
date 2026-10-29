import type { KeywordIdea } from "../keyword-options";
import { keywordIdeas, keywordsReady, keywordVolumes, type KeywordQuery } from "../keywords";
import type { Opportunity } from "../seo-types";

/**
 * Keyword Planner data for the autopilot, when keyword research is set up:
 * - rank pages by real monthly searches, so effort goes where moving up pays most
 * - give the writer related phrases people actually search
 * Anything missing or failing falls back to Search Console data alone.
 */

const TARGETING = { geo: "2840", language: "1000" } satisfies Omit<KeywordQuery, "keywords">;
const CTR_BY_POSITION = [0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02];
const ctrAt = (position: number) => CTR_BY_POSITION[Math.round(position) - 1] ?? 0.01;

export interface RelatedPhrase {
  keyword: string;
  monthlySearches: number;
}

export interface BoostedOpportunity extends Opportunity {
  /** Monthly Google searches for the query, when Keyword Planner knows it. */
  monthlySearches?: number;
}

/** Puts the opportunities with the most monthly clicks to gain (at position 3) first. */
export async function rankByVolume(ops: Opportunity[]): Promise<BoostedOpportunity[]> {
  if (!ops.length || !(await keywordsReady().catch(() => false))) return ops;
  const volumes = await keywordVolumes({ ...TARGETING, keywords: ops.map((o) => o.query) }).catch(() => null);
  if (!volumes) return ops;
  const byKeyword = new Map(volumes.map((v) => [v.keyword, v.avgMonthlySearches]));
  const boosted: BoostedOpportunity[] = ops.map((o) => {
    const searches = byKeyword.get(o.query.trim().toLowerCase().replace(/\s+/g, " "));
    return searches == null ? o : { ...o, monthlySearches: searches };
  });
  if (!boosted.some((o) => o.monthlySearches)) return ops;
  // Monthly clicks to gain if the page reached position 3; without a volume, fall back to Search Console impressions.
  const gain = (o: BoostedOpportunity) =>
    o.monthlySearches != null ? o.monthlySearches * Math.max(0, ctrAt(3) - ctrAt(o.position)) : o.potentialClicks;
  return boosted.sort((a, b) => gain(b) - gain(a));
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Up to 10 searched phrases close to the target query that aren't hard to rank for. */
export async function relatedPhrases(query: string, pageUrl: string): Promise<RelatedPhrase[]> {
  if (!(await keywordsReady().catch(() => false))) return [];
  const ideas: KeywordIdea[] = await keywordIdeas({ ...TARGETING, keywords: [query], url: pageUrl }).catch(() => []);
  const topic = words(query);
  return ideas
    .filter((i) => i.keyword.toLowerCase() !== query.toLowerCase() && (i.avgMonthlySearches ?? 0) >= 10 && i.competition !== "HIGH")
    .filter((i) => [...words(i.keyword)].some((w) => topic.has(w)))
    .slice(0, 10)
    .map((i) => ({ keyword: i.keyword, monthlySearches: i.avgMonthlySearches ?? 0 }));
}
