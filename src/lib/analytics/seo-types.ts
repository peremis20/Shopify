/** Shapes shared by the SEO tools on the server and the page. */

export interface Opportunity {
  query: string;
  page: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  /** Estimated extra clicks per period if the page reached position 3. */
  potentialClicks: number;
  /** Set when the search came from Keyword Planner (no Search Console data yet). */
  monthlySearches?: number;
  /** False until the daily rank check has looked this search up on Google. */
  checked?: boolean;
  /** Keyword Planner picks: what page one looks like for it, in a few words. */
  why?: string;
  /** Page one has room for a site like this. */
  winnable?: boolean;
  /** Long tail main target, or a broad search that supports them. */
  role?: "main" | "support";
}

export interface KeywordList {
  id: string;
  name: string;
  keywords: string[];
}

export interface RankingWeek {
  /** First day of the week, YYYY-MM-DD. */
  start: string;
  position: number | null;
  clicks: number;
  impressions: number;
}

export interface Ranking {
  keyword: string;
  weeks: RankingWeek[];
  /** Latest week with data. */
  position: number | null;
  /** Places gained over the last four weeks (positive is better). */
  change: number | null;
  clicks: number;
  impressions: number;
  topPage?: string;
}
