import { pageValues, valueWeight, type PageValue } from "../signals";
import { pathOf, type RankingApp } from "./types";

/** How visitors from Google behave on each page: pages that sell count more. */
export const analytics: RankingApp = {
  id: "analytics",
  name: "Google Analytics",
  role: "Weights pages by how well Google visitors convert, and flags pages people leave quickly",
  ready: (hub) => Boolean(hub.conn.gaPropertyId),

  async enrich(hub, cands) {
    const values = await pageValues(hub.conn).catch(() => new Map<string, PageValue>());
    hub.shared.set("analytics.values", values);
    // Pages that bring in money from Google count up to twice as much again, by their share of the top seller.
    const top = Math.max(0, ...[...values.values()].map((v) => v.revenue));
    for (const c of cands) {
      const v = values.get(pathOf(c.op.page));
      c.weights[this.id] = valueWeight(v) * (top > 0 && v ? 1 + v.revenue / top : 1);
    }
  },

  async brief(hub, c) {
    const v = (hub.shared.get("analytics.values") as Map<string, PageValue> | undefined)?.get(pathOf(c.op.page));
    if (!v || v.sessions < 10) return null;
    const rate = Math.round(v.engagementRate * 100);
    return {
      summary: v.revenue > 0 ? `Picked partly because Google visitors to this page bought ${Math.round(v.revenue)} worth in 28 days` : undefined,
      text: `Google Analytics, visitors from Google search over 28 days: ${v.sessions} sessions, ${rate}% engaged, ${v.keyEvents} key events (sales or sign ups)${v.revenue > 0 ? `, ${Math.round(v.revenue)} in sales` : ""}.${
        rate < 50 ? " Many leave quickly, so make the opening lines answer the search directly." : ""
      }`,
    };
  },
};
