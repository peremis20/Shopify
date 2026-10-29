import { pageHealth } from "../health";
import { pathOf, type RankingApp } from "./types";

/**
 * Index status, rich results and speed per page. A page Google hasn't
 * indexed can't rank whatever its content says, so the autopilot doesn't
 * spend a run rewriting it; the issue shows under Site health instead.
 */
export const siteHealth: RankingApp = {
  id: "site-health",
  name: "Site health (URL Inspection, PageSpeed)",
  role: "Checks that Google has your pages indexed, reads your rich results, and measures phone speed",
  ready: (hub) => Boolean(hub.conn.gscSiteUrl),

  async enrich(hub, cands) {
    const pages = [...new Set(cands.map((c) => c.op.page))];
    const health = new Map(await Promise.all(pages.map(async (p) => [p, await pageHealth(hub.accountId, p).catch(() => null)] as const)));
    hub.shared.set("site-health.pages", health);
    for (const c of cands) {
      if (health.get(c.op.page)?.indexed === false) c.weights[this.id] = 0.05;
    }
  },

  async brief(hub, c) {
    const h = (hub.shared.get("site-health.pages") as Map<string, Awaited<ReturnType<typeof pageHealth>>> | undefined)?.get(c.op.page);
    const issues = h?.issues.filter((i) => i.level !== "low") ?? [];
    if (!issues.length) return null;
    return {
      text: `Technical notes for ${pathOf(c.op.page)} (not fixable in the text, for context): ${issues.map((i) => i.text).join(" ")}`,
      summary: `Health: ${issues[0].text}`,
    };
  },
};
