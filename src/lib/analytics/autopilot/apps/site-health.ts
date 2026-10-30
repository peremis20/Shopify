import { ensureSchema, sql } from "../../db";
import { pageHealth, type HealthIssue } from "../health";
import { readSiteKeywords } from "../site-keywords";
import { readTargets } from "../targets";
import { pathOf, type Candidate, type RankingApp } from "./types";

/** Not on Google page one yet: treated as somewhere on page two or three. */
const OFF_PAGE_ONE = 25;
/** A page with a problem the autopilot can fix goes ahead of an equal page without one. */
const FIX_WEIGHT = 2;

/**
 * Problems a content change fixes: Google skipping or forgetting a page that
 * looks thin (a fresh section and links from newer articles), and broken
 * structured data (rebuilt from the page). Indexing settings, robots.txt,
 * 404s and speed need the site owner, so they stay on Site health.
 */
function fixable(issues: HealthIssue[]): HealthIssue[] {
  return issues.filter(
    (i) =>
      /^Not in Google: .*(discovered|crawled)/i.test(i.text) ||
      /^Google last crawled this page/i.test(i.text) ||
      /: (Error|Warning):/.test(i.text)
  );
}

/** A page Google left out on purpose (noindex, robots, a redirect, gone): rewriting it can't help. */
const blocked = (issues: HealthIssue[]) => issues.some((i) => /^Not in Google/.test(i.text) && !/(discovered|crawled)/i.test(i.text));

/**
 * Index status, rich results and speed per page. Pages with a problem a
 * content change can fix are suggested to the autopilot (with the search the
 * page aims at); pages Google leaves out on purpose are skipped, since no
 * rewrite helps them. The rest shows under Site health for the owner.
 */
export const siteHealth: RankingApp = {
  id: "site-health",
  name: "Site health (URL Inspection, PageSpeed)",
  role: "Checks that Google has your pages indexed, fixes what a content change can (thin or forgotten pages, broken structured data), and measures phone speed",
  ready: (hub) => Boolean(hub.conn.gscSiteUrl),

  async candidates(hub) {
    await ensureSchema();
    const rows = await sql`SELECT url, issues FROM insights_page_health WHERE account_id = ${hub.accountId}`;
    const [kws, targets] = await Promise.all([readSiteKeywords(hub.accountId).catch(() => []), readTargets(hub.accountId).catch(() => [])]);
    const out: Candidate[] = [];
    for (const r of rows) {
      const issues = JSON.parse(r.issues ?? "[]") as HealthIssue[];
      if (!fixable(issues).length || blocked(issues)) continue;
      // The search this page aims at: one the owner chose, else its main keyword.
      const t = targets.find((x) => x.page === r.url && x.role !== "support");
      const k = kws.find((x) => x.page === r.url && x.role !== "support");
      const query = t?.keyword ?? k?.keyword;
      if (!query) continue;
      const monthlySearches = t?.monthlySearches ?? k?.monthlySearches ?? 0;
      out.push({
        op: {
          query,
          page: r.url!,
          position: OFF_PAGE_ONE,
          impressions: 0,
          clicks: 0,
          ctr: 0,
          potentialClicks: Math.max(1, Math.round(monthlySearches * 0.1)),
          monthlySearches,
        },
        mode: "climb",
        weights: { [this.id]: FIX_WEIGHT },
      });
    }
    return out;
  },

  async enrich(hub, cands) {
    const pages = [...new Set(cands.map((c) => c.op.page))];
    const health = new Map(await Promise.all(pages.map(async (p) => [p, await pageHealth(hub.accountId, p).catch(() => null)] as const)));
    hub.shared.set("site-health.pages", health);
    for (const c of cands) {
      const h = health.get(c.op.page);
      if (!h) continue;
      // Left out of Google on purpose: a rewrite can't change that.
      if (h.indexed === false && blocked(h.issues)) c.weights[this.id] = 0.05;
      else if (fixable(h.issues).length) c.weights[this.id] = FIX_WEIGHT;
    }
  },

  async brief(hub, c) {
    const h = (hub.shared.get("site-health.pages") as Map<string, Awaited<ReturnType<typeof pageHealth>>> | undefined)?.get(c.op.page);
    if (!h) return null;
    const fix = fixable(h.issues);
    const other = h.issues.filter((i) => i.level !== "low" && !fix.includes(i));
    if (!fix.length && !other.length) return null;
    const parts: string[] = [];
    if (fix.some((i) => /^Not in Google|^Google last crawled/.test(i.text)))
      parts.push(
        "Google is skipping or has forgotten this page, usually because it looks thin or too like other pages. Make the new section genuinely useful and distinct from the rest of the site, so the page earns a fresh crawl."
      );
    if (fix.some((i) => /: (Error|Warning):/.test(i.text))) parts.push(`Its structured data has problems (${fix.map((i) => i.text).join(" ")}); it's rebuilt from the page with this change.`);
    if (other.length) parts.push(`Technical notes (not fixable in the text, for context): ${other.map((i) => i.text).join(" ")}`);
    return { text: `${pathOf(c.op.page)}: ${parts.join(" ")}`, summary: `Health: ${(fix[0] ?? other[0]).text}` };
  },
};
