import { keywordsReady } from "../../keywords";
import { relatedPhrases, withVolumes } from "../keyword-boost";
import { keyOf, type RankingApp } from "./types";

/** Real monthly Google searches: sizes every opportunity and supplies related phrases. */
export const keywordPlanner: RankingApp = {
  id: "keyword-planner",
  name: "Google Keyword Planner",
  role: "Sizes each search by real monthly volume and suggests related phrases to cover",
  ready: () => keywordsReady().catch(() => false),

  async enrich(_hub, cands) {
    const sized = await withVolumes(cands.map((c) => c.op));
    const volume = new Map(sized.map((o) => [keyOf(o), o.monthlySearches]));
    for (const c of cands) {
      const v = volume.get(keyOf(c.op));
      if (v != null) c.op = { ...c.op, monthlySearches: v };
    }
  },

  async brief(hub, c) {
    const phrases = await relatedPhrases(c.op.query, c.op.page);
    hub.shared.set("keyword-planner.related", phrases);
    const volume = c.op.monthlySearches != null ? `"${c.op.query}" gets about ${c.op.monthlySearches.toLocaleString("en-US")} Google searches a month in the US.\n` : "";
    if (!phrases.length && !volume) return null;
    return {
      text: `${volume}${
        phrases.length
          ? `Related phrases people search each month: ${phrases.map((p) => `${p.keyword} (${p.monthlySearches})`).join(", ")}.
Work the most relevant one or two into the description, and cover the others naturally in any new section. Only use phrases that fit the page; never stuff keywords.`
          : ""
      }`,
    };
  },
};
