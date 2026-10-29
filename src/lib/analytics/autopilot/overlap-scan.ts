import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { cannibalizedQueries, nearlySame, overlap, shingles, siteIndex, type Cannibal, type SiteItem } from "./guards";
import type { StoreAccess } from "./shopify";

/**
 * Weekly overlap check of the whole site: SEO titles and descriptions used by
 * more than one page, posts that largely repeat each other, and searches where
 * several pages compete. Read only: each finding comes with what to do.
 */

const RECHECK_DAYS = 7;
const key = (accountId: string) => `overlap:${accountId}`;

export interface SameText {
  text: string;
  paths: string[];
}

export interface SimilarPair {
  a: string;
  b: string;
  /** Share of the shorter page found in the other, 0 to 1. */
  overlap: number;
}

export interface OverlapReport {
  checkedAt: string | null;
  scanned: number;
  titles: SameText[];
  descriptions: SameText[];
  similar: SimilarPair[];
  competing: Cannibal[];
}

const EMPTY: OverlapReport = { checkedAt: null, scanned: 0, titles: [], descriptions: [], similar: [], competing: [] };

function groupSame(items: SiteItem[], pick: (i: SiteItem) => string | null): SameText[] {
  const groups: SameText[] = [];
  for (const i of items) {
    const v = pick(i);
    if (!v) continue;
    const g = groups.find((x) => nearlySame(x.text, v));
    if (g) g.paths.push(i.path);
    else groups.push({ text: v, paths: [i.path] });
  }
  return groups.filter((g) => g.paths.length > 1);
}

export async function overlapScanDue(accountId: string): Promise<boolean> {
  await ensureSchema();
  const [row] = await sql`SELECT updated_at FROM insights_settings WHERE key = ${key(accountId)}`;
  return !row?.updated_at || Date.now() - new Date(row.updated_at).getTime() > RECHECK_DAYS * 864e5;
}

/** Scans a site's pages: a Shopify store's, or (with `items`) any website's read from its sitemap. */
export async function scanOverlap(accountId: string, source: StoreAccess | SiteItem[], conn: Connection | null, brand: string): Promise<number> {
  const site = Array.isArray(source) ? source : await siteIndex(source);
  const titles = groupSame(site, (i) => i.seoTitle);
  const descriptions = groupSame(site, (i) => i.seoDescription);

  // Long enough posts and pages only; products share label wording on purpose.
  const texts = site.filter((i) => (i.kind === "article" || i.kind === "page") && i.text.length > 600).map((i) => ({ path: i.path, sh: shingles(i.text) }));
  const similar: SimilarPair[] = [];
  for (let x = 0; x < texts.length; x++) {
    for (let y = x + 1; y < texts.length; y++) {
      const o = overlap(texts[x].sh, texts[y].sh);
      if (o >= 0.3) similar.push({ a: texts[x].path, b: texts[y].path, overlap: Math.round(o * 100) / 100 });
    }
  }
  similar.sort((p, q) => q.overlap - p.overlap);

  const competing = conn?.gscSiteUrl ? await cannibalizedQueries(conn, brand).catch(() => []) : [];
  const report: OverlapReport = {
    checkedAt: new Date().toISOString(),
    scanned: site.length,
    titles,
    descriptions,
    similar: similar.slice(0, 25),
    competing,
  };
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${key(accountId)}, ${JSON.stringify(report)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return titles.length + descriptions.length + similar.length + competing.length;
}

export async function overlapReport(accountId: string): Promise<OverlapReport> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key(accountId)}`;
  return row?.value ? (JSON.parse(row.value) as OverlapReport) : EMPTY;
}
