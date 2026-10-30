import { keywordsReady } from "../../keywords";
import { readSiteKeywords, siteKeywordsActive, supportFor } from "../site-keywords";
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
  // Also while Search Console is new or has too little data (see maintain in handlers.ts).
  ready: async (hub) =>
    Boolean(hub.platform.serperKey) &&
    (!hub.conn.gscSiteUrl || (await siteKeywordsActive(hub.accountId).catch(() => false))) &&
    (await keywordsReady().catch(() => false)),

  async candidates(hub) {
    const [kws, rows] = await Promise.all([readSiteKeywords(hub.accountId), rankWatch(hub.accountId)]);
    const byQuery = new Map(rows.map((r) => [r.query, r]));
    const out: Candidate[] = [];
    for (const k of kws) {
      // Broad searches aren't targets of their own; they back up the main ones (see brief).
      if (k.role === "support") continue;
      const row = byQuery.get(k.keyword);
      // Only searches checked on Google at least once, so the position is real.
      if (!row) continue;
      const position = row.position ?? OFF_PAGE_ONE;
      if (position === 1) continue;
      // Page one is all big publishers and we're not on it: not worth the effort yet.
      if (k.winnable === false && position >= OFF_PAGE_ONE) continue;
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

  async brief(hub, c) {
    const support = await supportFor(hub.accountId, c.op.page).catch(() => []);
    return {
      text: `Search Console has little or no data for this site yet, so this search was chosen from Keyword Planner: about ${c.op.monthlySearches ?? "some"} searches a month, and the site is ${
        c.op.position >= OFF_PAGE_ONE ? "not on Google page one for it yet" : `#${c.op.position} on Google today`
      }. Make the page clearly about this search without changing what it offers.${
        support.length
          ? ` Also use these broader related searches naturally where they fit, to support it (don't make them the focus): ${support.join(", ")}.`
          : ""
      }`,
    };
  },
};
