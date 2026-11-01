import { readPrune, rewrittenSince } from "../pruner";
import type { Candidate, RankingApp } from "./types";

/** An article Google hasn't shown in 90 days: worth a real rewrite before anything else happens to it. */
const REWRITE_WEIGHT = 3;

const topicOf = (url: string) => {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  } catch {
    return "";
  }
};

/** Articles the pruning check flagged: rewritten first, so they get a fair chance before being taken down. */
export const prune: RankingApp = {
  id: "prune",
  name: "Pruning check",
  role: "Rewrites articles Google hasn't shown in 90 days, and takes them down only if that doesn't help",
  ready: async (hub) => Object.values((await readPrune(hub.accountId).catch(() => null))?.pages ?? {}).some((e) => e.stage === "rewrite"),

  async candidates(hub) {
    const state = await readPrune(hub.accountId).catch(() => null);
    const out: Candidate[] = [];
    for (const e of Object.values(state?.pages ?? {})) {
      if (e.stage !== "rewrite" || !e.url) continue;
      // Already rewritten since it was flagged: give it its 60 days.
      if (await rewrittenSince(hub.accountId, e.url, e.since).catch(() => true)) continue;
      const query = topicOf(e.url);
      if (!query) continue;
      out.push({
        op: { query, page: e.url, position: 25, impressions: 0, clicks: 0, ctr: 0, potentialClicks: 15 },
        mode: "climb",
        inferred: true,
        weights: { [this.id]: REWRITE_WEIGHT },
      });
    }
    return out;
  },

  async brief(_hub, c) {
    if (c.weights[this.id] === undefined) return null;
    return {
      text: "Google hasn't shown this article in search for 90 days. Rewrite the new section so the page is clearly more useful, specific and different from similar pages, answering a real question people have about its topic. If it doesn't start showing up in about 60 days it will be taken down.",
      summary: "Rewriting an article Google hasn't shown in 90 days",
    };
  },
};
