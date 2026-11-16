import { readSiteKeywords } from "../site-keywords";
import { readTargets } from "../targets";
import { readStoreAudit, type StoreAudit, type StoreFinding } from "../store-audit";
import { findingsData } from "../writer";
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

/** A page's address for matching: no scheme, no www, no trailing slash, lower case host. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "");
  }
}

/** The autopilot's fixes from a recent audit only (checked within FRESH_DAYS), by page key. */
export function autopilotFixes(audit: Pick<StoreAudit, "at" | "findings" | "findingsAt"> | null, now = Date.now()): Map<string, StoreFinding[]> {
  const out = new Map<string, StoreFinding[]>();
  const checked = audit?.findingsAt ?? null;
  if (!audit || !checked || now - Date.parse(checked) >= FRESH_DAYS * 864e5) return out;
  for (const f of audit.findings) if (f.who === "autopilot") out.set(pageKey(f.page), [...(out.get(pageKey(f.page)) ?? []), f]);
  return out;
}

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
    const byPage = autopilotFixes(audit);
    hub.shared.set("store-audit.findings", byPage);
    if (!byPage.size) return [];
    const [kws, targets] = await Promise.all([readSiteKeywords(hub.accountId).catch(() => []), readTargets(hub.accountId).catch(() => [])]);
    const titles = new Map((audit?.pages ?? []).map((p) => [pageKey(p.url), p.facts?.title ?? null]));
    const out: Candidate[] = [];
    for (const fixes of byPage.values()) {
      const page = fixes[0].page;
      const t = targets.find((x) => x.page && pageKey(x.page) === pageKey(page) && x.role !== "support");
      const k = kws.find((x) => pageKey(x.page) === pageKey(page) && x.role !== "support");
      const query = t?.keyword ?? k?.keyword ?? topicOf(titles.get(pageKey(page)) ?? null, page);
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
      map = autopilotFixes(await readStoreAudit(hub.accountId).catch(() => null));
      hub.shared.set("store-audit.findings", map);
    }
    for (const c of cands) {
      const fixes = map.get(pageKey(c.op.page)) ?? [];
      if (fixes.length) c.weights[this.id] = Math.max(c.weights[this.id] ?? 0, fixes.some((f) => f.impact === "high") ? HIGH_WEIGHT : FIX_WEIGHT);
    }
  },

  async brief(hub, c) {
    const fixes = (hub.shared.get("store-audit.findings") as Map<string, StoreFinding[]> | undefined)?.get(pageKey(c.op.page)) ?? [];
    if (!fixes.length) return null;
    const parts = [...new Set(fixes.map((f) => PART[f.field]).filter(Boolean))];
    return {
      text: `Store audit of ${pathOf(c.op.page)}: a second AI checked these findings against the page as visitors get it. Use them only to decide what to improve in ${parts.join(", ") || "the page"}, and only with facts the page itself states.
${findingsData(fixes)}`,
      summary: `Store audit: ${fixes[0].problem}`,
    };
  },
};
