import { rankWatch, type RankWatchRow } from "../tracking";
import type { Candidate, RankingApp } from "./types";

/**
 * Today's Google positions, checked every morning. Catches a page one drop
 * days before Search Console shows it, and defends it straight away.
 */
export const dailyRank: RankingApp = {
  id: "daily-rank",
  name: "Daily rank tracking",
  role: "Checks your key searches on Google every day and defends a drop the next morning",
  ready: (hub) => Boolean(hub.platform.serperKey),

  async candidates(hub) {
    const rows = await rankWatch(hub.accountId);
    hub.shared.set("daily-rank.rows", rows);
    const out: Candidate[] = [];
    for (const r of rows) {
      if (r.best7 === null || r.best7 > 10 || !r.url) continue;
      const now = r.position ?? 11;
      // A slip of 2+ spots, or 1+ from the top 3, compared with the best day this week.
      if (now - r.best7 < (r.best7 <= 3 ? 1 : 2)) continue;
      out.push({
        op: { query: r.query, page: r.url.split("#")[0].split("?")[0], position: now, impressions: 0, clicks: 0, ctr: 0, potentialClicks: Math.round((now - r.best7) * 10) },
        mode: "defend",
        previousPosition: r.best7,
        weights: {},
      });
    }
    return out;
  },

  async brief(hub, c) {
    const rows = (hub.shared.get("daily-rank.rows") as RankWatchRow[] | undefined) ?? (await rankWatch(hub.accountId));
    const row = rows.find((r) => r.query === c.op.query.toLowerCase());
    if (!row) return null;
    const days = row.history.slice(-7).map((h) => `${h.day.slice(5)}: ${h.position ?? "not on page one"}`).join(", ");
    return {
      text: `Daily Google positions for "${row.query}" (last 7 checks): ${days}.`,
      summary: row.position !== row.previous && row.previous !== null ? `Daily check: ${row.previous} → ${row.position ?? "off page one"}.` : undefined,
    };
  },
};
