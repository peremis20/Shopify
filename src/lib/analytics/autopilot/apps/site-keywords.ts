import { keywordsReady } from "../../keywords";
import { readSiteKeywords } from "../site-keywords";
import { rankWatch } from "../tracking";
import type { Candidate, RankingApp } from "./types";

/** Not on Google page one yet: treated as somewhere on page two or three. */
const OFF_PAGE_ONE = 25;

/**
 * For sites without Search Console: the searches each page should win, from
 * Keyword Planner, with today's Google position from the daily rank check.
 * Suggests the ones closest to the top with the most searches, so the
 * autopilot works from day one, verified or not.
 */
export const siteKeywords: RankingApp = {
  id: "site-keywords",
  name: "Keyword targets (no Search Console needed)",
  role: "Picks the searches each page should win and tracks where you stand on Google",
  ready: async (hub) => !hub.conn.gscSiteUrl && Boolean(hub.platform.serperKey) && (await keywordsReady().catch(() => false)),

  async candidates(hub) {
    const [kws, rows] = await Promise.all([readSiteKeywords(hub.accountId), rankWatch(hub.accountId)]);
    const byQuery = new Map(rows.map((r) => [r.query, r]));
    const out: Candidate[] = [];
    for (const k of kws) {
      const row = byQuery.get(k.keyword);
      // Only searches checked on Google at least once, so the position is real.
      if (!row) continue;
      const position = row.position ?? OFF_PAGE_ONE;
      if (position === 1) continue;
      const page = (row.url ?? k.page).split("#")[0].split("?")[0];
      out.push({
        op: {
          query: k.keyword,
          page,
          position,
          impressions: 0,
          clicks: 0,
          ctr: 0,
          potentialClicks: Math.round(k.monthlySearches * 0.1),
          monthlySearches: k.monthlySearches,
        },
        mode: position <= 3 ? "top" : "climb",
        weights: {},
      });
    }
    return out;
  },

  async brief(_hub, c) {
    return {
      text: `This site has no Search Console data, so this search was chosen from Keyword Planner: about ${c.op.monthlySearches ?? "some"} searches a month, and the site is ${
        c.op.position >= OFF_PAGE_ONE ? "not on Google page one for it yet" : `#${c.op.position} on Google today`
      }. Make the page clearly about this search without changing what it offers.`,
    };
  },
};
