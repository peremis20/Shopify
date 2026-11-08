import { readSiteKeywords } from "../site-keywords";
import { readTargets } from "../targets";
import { readAudit, type AuditIssue } from "../site-audit";
import { pathOf, type Candidate, type RankingApp } from "./types";

/** Not on Google page one yet: treated as somewhere on page two or three. */
const OFF_PAGE_ONE = 25;
/** A page with a problem the autopilot can fix goes ahead of an equal page without one; a missing title or a thin article more so. */
const FIX_WEIGHT = 1.5;
const SERIOUS_WEIGHT = 2;
const UNKNOWN_POTENTIAL = 5;

const topicOf = (title: string | null, url: string) =>
  ((title ?? "").split(/\s[|–—-]\s/)[0] || decodeURIComponent(pathOf(url).split("/").filter(Boolean).pop() ?? "").replace(/[-_]+/g, " "))
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** What the writer is asked to fix, issue by issue. */
const ASK: Record<string, string> = {
  "title-missing": "It has no SEO title: write one.",
  "title-long": "Its SEO title is too long for Google: write one under 60 characters.",
  "title-short": "Its SEO title is too short to say what the page is: write a clear one.",
  "title-dup": "Another page uses the same title: write one that is clearly this page's own.",
  "description-missing": "It has no meta description: write one.",
  "description-dup": "Another page uses the same meta description: write one that is clearly this page's own.",
  thin: "It is thin: add a substantial, genuinely useful section.",
  alt: "Some images have no alt text: describe them.",
};

/**
 * The Site Auditor's findings (site-audit.ts) that a content change fixes, handed to the autopilot as pages to work
 * on, with exactly what to fix. Problems only a person can fix are shown to the owner instead (Inspector).
 */
export const siteAudit: RankingApp = {
  id: "site-audit",
  name: "Site Auditor (every page, every week)",
  role: "Reads every page of the site weekly and fixes missing or duplicate titles and descriptions, thin articles and images with no description",
  ready: () => true,

  async candidates(hub) {
    const [pages, kws, targets] = await Promise.all([
      readAudit(hub.accountId).catch(() => []),
      readSiteKeywords(hub.accountId).catch(() => []),
      readTargets(hub.accountId).catch(() => []),
    ]);
    const out: Candidate[] = [];
    for (const p of pages) {
      // Only real problems send a page to the autopilot; a small one (a long title) waits until the page is picked anyway.
      const fix = p.issues.filter((i) => i.auto && i.level !== "low");
      if (!fix.length || p.issues.some((i) => i.code === "error" || i.code === "noindex")) continue;
      const t = targets.find((x) => x.page === p.url && x.role !== "support");
      const k = kws.find((x) => x.page === p.url && x.role !== "support");
      const query = t?.keyword ?? k?.keyword ?? topicOf(p.title, p.url);
      if (!query) continue;
      const monthlySearches = t?.monthlySearches ?? k?.monthlySearches;
      const serious = fix.some((i) => i.code === "title-missing" || i.code === "thin");
      out.push({
        op: {
          query,
          page: p.url,
          position: OFF_PAGE_ONE,
          impressions: 0,
          clicks: 0,
          ctr: 0,
          potentialClicks: monthlySearches ? Math.max(1, Math.round(monthlySearches * 0.1)) : UNKNOWN_POTENTIAL,
          ...(monthlySearches ? { monthlySearches } : {}),
        },
        mode: "climb",
        ...(t?.keyword || k?.keyword ? {} : { inferred: true }),
        weights: { [this.id]: serious ? SERIOUS_WEIGHT : FIX_WEIGHT },
      });
    }
    hub.shared.set("site-audit.pages", new Map(pages.map((p) => [p.url, p.issues])));
    return out;
  },

  async enrich(hub, cands) {
    let map = hub.shared.get("site-audit.pages") as Map<string, AuditIssue[]> | undefined;
    if (!map) {
      map = new Map((await readAudit(hub.accountId).catch(() => [])).map((p) => [p.url, p.issues]));
      hub.shared.set("site-audit.pages", map);
    }
    for (const c of cands) {
      const fix = (map.get(c.op.page) ?? []).filter((i) => i.auto);
      if (fix.length) c.weights[this.id] = Math.max(c.weights[this.id] ?? 0, fix.some((i) => i.code === "title-missing" || i.code === "thin") ? SERIOUS_WEIGHT : FIX_WEIGHT);
    }
  },

  async brief(hub, c) {
    const issues = ((hub.shared.get("site-audit.pages") as Map<string, AuditIssue[]> | undefined)?.get(c.op.page) ?? []).filter((i) => i.auto);
    if (!issues.length) return null;
    const asks = [...new Set(issues.map((i) => ASK[i.code]).filter(Boolean))];
    return { text: `Site audit of ${pathOf(c.op.page)}: ${asks.join(" ")}`, summary: `Audit: ${issues[0].text}` };
  },
};
