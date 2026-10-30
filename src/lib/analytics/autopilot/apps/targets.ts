import { readTargets } from "../targets";
import { rankWatch } from "../tracking";
import type { Candidate, RankingApp } from "./types";

/** Not on Google page one yet: treated as somewhere on page two or three. */
const OFF_PAGE_ONE = 25;
/** The owner chose these, so they go ahead of what the autopilot finds itself. */
const PRIORITY = 3;

/** Searches the owner picked with "Rank for this", each aimed at the page that fits it best. */
export const targets: RankingApp = {
  id: "targets",
  name: "Searches you chose",
  role: "Works first on the searches you picked with Rank for this",
  ready: async (hub) => (await readTargets(hub.accountId)).some((t) => t.page),

  async candidates(hub) {
    const [list, rows] = await Promise.all([readTargets(hub.accountId), rankWatch(hub.accountId)]);
    const byQuery = new Map(rows.map((r) => [r.query, r]));
    const out: Candidate[] = [];
    for (const t of list) {
      if (!t.page) continue;
      const row = byQuery.get(t.keyword);
      const position = row?.position ?? OFF_PAGE_ONE;
      if (position === 1) continue;
      out.push({
        op: {
          query: t.keyword,
          page: (row?.url ?? t.page).split("#")[0].split("?")[0],
          position,
          impressions: 0,
          clicks: 0,
          ctr: 0,
          potentialClicks: Math.max(1, Math.round(t.monthlySearches * 0.1)),
          monthlySearches: t.monthlySearches,
        },
        mode: position <= 3 ? "top" : "climb",
        weights: { targets: PRIORITY },
      });
    }
    return out;
  },

  async brief(hub, c) {
    const t = (await readTargets(hub.accountId)).find((x) => x.keyword === c.op.query);
    if (!t) return null;
    return {
      text: `The site owner chose this search to rank for (about ${t.monthlySearches} searches a month; ${t.why}). Make this page clearly and genuinely about "${t.keyword}": use it naturally in the title, description and new section, and answer what people searching it want to know, without changing what the page offers.`,
    };
  },
};
