import { findOpportunities } from "../../seo-tools";
import type { Opportunity } from "../../seo-types";
import { topPositionSignals } from "../signals";
import { keyOf, type Candidate, type RankingApp } from "./types";

/**
 * Where the store ranks today. Suggests, in order of urgency: page one
 * searches that are slipping (defend), #2 to #3 searches (go for #1), and
 * #4 to #20 searches (go for the top 3).
 */
export const searchConsole: RankingApp = {
  id: "search-console",
  name: "Search Console",
  role: "Finds pages slipping on page one and searches close to the top",
  ready: (hub) => Boolean(hub.conn.gscSiteUrl),

  async candidates(hub) {
    const [climb, signals] = await Promise.all([
      findOpportunities(hub.conn, "28d"),
      topPositionSignals(hub.conn).catch(() => ({ slipping: [], nearTop: [] })),
    ]);
    const all: Opportunity[] = [...signals.slipping, ...signals.nearTop, ...climb];
    hub.shared.set("search-console.rows", all);

    const seen = new Set<string>();
    const out: Candidate[] = [];
    const add = (op: Opportunity, mode: Candidate["mode"], previousPosition?: number) => {
      if (seen.has(keyOf(op))) return;
      seen.add(keyOf(op));
      out.push({ op, mode, previousPosition, weights: {} });
    };
    for (const s of signals.slipping) add(s, "defend", s.previousPosition);
    for (const o of signals.nearTop) add(o, "top");
    for (const o of climb) add(o, "climb");
    return out;
  },

  async brief(hub, c) {
    const rows = (hub.shared.get("search-console.rows") as Opportunity[] | undefined) ?? [];
    const others = [...new Set(rows.filter((o) => o.page === c.op.page && o.query !== c.op.query).map((o) => o.query))];
    return others.length
      ? { text: `Other searches this page appears for on Google: ${others.slice(0, 15).join(", ")}.` }
      : null;
  },
};
