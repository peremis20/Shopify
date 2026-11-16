import { readSiteKeywords } from "../site-keywords";
import { readTargets } from "../targets";
import { readStoreAudit, type StoreFinding } from "../store-audit";
import { topicOf } from "./site-audit";
import { pathOf, type Candidate, type RankingApp } from "./types";

/** Not on Google page one yet: treated as somewhere on page two or three (as the Site Auditor does). */
const OFF_PAGE_ONE = 25;
/** A page with a store audit fix the autopilot can make goes ahead of an equal page without one; a high impact one more so. */
const FIX_WEIGHT = 1.5;
const HIGH_WEIGHT = 2;
const UNKNOWN_POTENTIAL = 5;
/** Findings older than this wait for the next weekly audit instead of being acted on. */
const FRESH_DAYS = 14;

/** What the writer is asked to fix, by the part the finding changes. */
const PART: Record<string, string> = {
  seo_title: "the SEO title",
  meta_description: "the meta description",
  page_text: "a new section of the page text",
};

/**
 * The Store audit's findings (store-audit.ts) that the autopilot can already make (an SEO title, a meta description, the
 * text of a content page), handed to the autopilot as pages to work on, with exactly what to fix. The autopilot then
 * follows the owner's approval rules and its usual checks. Everything else stays on the owner's fix list.
 */
export const storeAudit: RankingApp = {
  id: "store-audit",
  name: "Store audit (what stops a sale on key pages)",
  role: "Checks the store's key pages weekly for what stops visitors from buying, and fixes the titles, descriptions and page text it can",
  ready: () => true,

  async candidates(hub) {
    const audit = await readStoreAudit(hub.accountId).catch(() => null);
    const fresh = audit && Date.now() - Date.parse(audit.at) < FRESH_DAYS * 864e5 ? audit.findings.filter((f) => f.who === "autopilot") : [];
    const byPage = new Map<string, StoreFinding[]>();
    for (const f of fresh) byPage.set(f.page, [...(byPage.get(f.page) ?? []), f]);
    hub.shared.set("store-audit.findings", byPage);
    if (!byPage.size) return [];
    const [kws, targets] = await Promise.all([readSiteKeywords(hub.accountId).catch(() => []), readTargets(hub.accountId).catch(() => [])]);
    const titles = new Map((audit?.pages ?? []).map((p) => [p.url, p.facts?.title ?? null]));
    const out: Candidate[] = [];
    for (const [page, fixes] of byPage) {
      const t = targets.find((x) => x.page === page && x.role !== "support");
      const k = kws.find((x) => x.page === page && x.role !== "support");
      const query = t?.keyword ?? k?.keyword ?? topicOf(titles.get(page) ?? null, page);
      if (!query) continue;
      const monthlySearches = t?.monthlySearches ?? k?.monthlySearches;
      out.push({
        op: {
          query,
          page,
          position: OFF_PAGE_ONE,
          impressions: 0,
          clicks: 0,
          ctr: 0,
          potentialClicks: monthlySearches ? Math.max(1, Math.round(monthlySearches * 0.1)) : UNKNOWN_POTENTIAL,
          ...(monthlySearches ? { monthlySearches } : {}),
        },
        mode: "climb",
        ...(t?.keyword || k?.keyword ? {} : { inferred: true }),
        weights: { [this.id]: fixes.some((f) => f.impact === "high") ? HIGH_WEIGHT : FIX_WEIGHT },
      });
    }
    return out;
  },

  async enrich(hub, cands) {
    let map = hub.shared.get("store-audit.findings") as Map<string, StoreFinding[]> | undefined;
    if (!map) {
      const audit = await readStoreAudit(hub.accountId).catch(() => null);
      map = new Map();
      for (const f of audit?.findings.filter((x) => x.who === "autopilot") ?? []) map.set(f.page, [...(map.get(f.page) ?? []), f]);
      hub.shared.set("store-audit.findings", map);
    }
    for (const c of cands) {
      const fixes = map.get(c.op.page) ?? [];
      if (fixes.length) c.weights[this.id] = Math.max(c.weights[this.id] ?? 0, fixes.some((f) => f.impact === "high") ? HIGH_WEIGHT : FIX_WEIGHT);
    }
  },

  async brief(hub, c) {
    const fixes = (hub.shared.get("store-audit.findings") as Map<string, StoreFinding[]> | undefined)?.get(c.op.page) ?? [];
    if (!fixes.length) return null;
    const asks = fixes.map((f) => `In ${PART[f.field] ?? "the page"}: ${f.problem} Fix: ${f.fix}`);
    return {
      text: `Store audit of ${pathOf(c.op.page)} (checked by a second AI against the page as visitors get it). Make these changes only with facts the page itself states: ${asks.join(" ")}`,
      summary: `Store audit: ${fixes[0].problem}`,
    };
  },
};
