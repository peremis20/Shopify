import type { Connection } from "../connection";
import { resolveRange, toIso } from "../dates";
import { googleRequest } from "../google-auth";
import { paged } from "./link-fixer";
import type { StoreAccess } from "./shopify";

/**
 * Guards that keep the autopilot from hurting a site while it tries to help:
 * - no SEO title or description that another page already uses (or nearly)
 * - no new section copied from another page
 * - one page per search: when two pages compete, only the stronger one is worked on
 * - pages that should never change (contact, policies, reviews, legal)
 * - titles trimmed at a word, never mid-word
 * - an emergency brake when the site's Google clicks suddenly fall
 */

// ---------- the site's pages ----------

export interface SiteItem {
  /** Path, like /blogs/news/post or /products/handle. */
  path: string;
  kind: "article" | "page" | "product" | "collection";
  title: string;
  /** The SEO title Google sees: the custom one, or the page title. */
  seoTitle: string;
  seoDescription: string | null;
  text: string;
}

const SEO = `titleTag: metafield(namespace: "global", key: "title_tag") { value } descTag: metafield(namespace: "global", key: "description_tag") { value }`;
type Seo = { titleTag: { value: string } | null; descTag: { value: string } | null };

export const plainText = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Every published post and page, active product and collection, with what Google sees of it. */
export async function siteIndex(s: StoreAccess): Promise<SiteItem[]> {
  const [articles, pages, products, collections] = await Promise.all([
    paged<Seo & { handle: string; title: string; body: string | null; isPublished: boolean; blog: { handle: string } }>(s, "articles", `handle title body isPublished blog { handle } ${SEO}`),
    paged<Seo & { handle: string; title: string; body: string | null; isPublished: boolean }>(s, "pages", `handle title body isPublished ${SEO}`),
    paged<Seo & { handle: string; title: string; descriptionHtml: string | null; status: string }>(s, "products", `handle title descriptionHtml status ${SEO}`),
    paged<Seo & { handle: string; title: string; descriptionHtml: string | null }>(s, "collections", `handle title descriptionHtml ${SEO}`),
  ]);
  const item = (kind: SiteItem["kind"], path: string, x: Seo & { title: string }, html: string): SiteItem => ({
    kind,
    path,
    title: x.title,
    seoTitle: x.titleTag?.value || x.title,
    seoDescription: x.descTag?.value || null,
    text: plainText(html),
  });
  return [
    ...articles.filter((a) => a.isPublished).map((a) => item("article", `/blogs/${a.blog.handle}/${a.handle}`, a, a.body ?? "")),
    ...pages.filter((p) => p.isPublished).map((p) => item("page", `/pages/${p.handle}`, p, p.body ?? "")),
    ...products.filter((p) => p.status === "ACTIVE").map((p) => item("product", `/products/${p.handle}`, p, p.descriptionHtml ?? "")),
    ...collections.map((c) => item("collection", `/collections/${c.handle}`, c, c.descriptionHtml ?? "")),
  ];
}

// ---------- duplicates ----------

const STOP = new Set("a an and the of for to in on with your our you is are at by from or how what why".split(" "));
const BRAND_TAIL = /\s*[|·\-–—:]\s*[^|·\-–—:]{2,30}$/;

/** Words of a title or description, without the brand suffix, filler words or plurals. */
function titleWords(s: string): string[] {
  return s
    .replace(BRAND_TAIL, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Same words, or nearly (at least 85% shared), ignoring order. */
export function nearlySame(a: string, b: string): boolean {
  const A = new Set(titleWords(a));
  const B = new Set(titleWords(b));
  if (!A.size || !B.size) return false;
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / Math.max(A.size, B.size) >= 0.85;
}

/** The other page that already uses this title or description, if any. */
export function duplicateOf(value: string, selfPath: string, items: SiteItem[], field: "title" | "description"): SiteItem | null {
  return (
    items.find((i) => {
      if (i.path === selfPath) return false;
      const other = field === "title" ? i.seoTitle : i.seoDescription;
      return Boolean(other) && nearlySame(value, other!);
    }) ?? null
  );
}

/** Overlapping runs of 5 words, the usual way to spot copied text. */
export function shingles(text: string, n = 5): Set<string> {
  const w = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/** The page a paragraph was mostly copied from (half or more of its 5 word runs), if any. Short lines are never flagged. */
export function copiedFrom(text: string, selfPath: string, items: SiteItem[], cache: Map<string, Set<string>>): SiteItem | null {
  const mine = shingles(text);
  if (mine.size < 6) return null;
  for (const i of items) {
    let theirs = cache.get(i.path);
    if (!theirs) cache.set(i.path, (theirs = shingles(i.text)));
    const copied = [...mine].filter((s) => theirs!.has(s)).length;
    if (copied / mine.size >= 0.5) return i;
  }
  return null;
}

/** How much two pages overlap (0 to 1), by shared 5 word runs. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const s of small) if (big.has(s)) shared++;
  return shared / small.size;
}

// ---------- small rules ----------

/** Pages the autopilot never touches: they carry legal, contact or review content people rely on as written. */
export const PROTECTED_PAGE = /^\/pages\/[^/]*(contact|privacy|terms|refund|return|shipping|polic|legal|cookie|accessibility|disclaimer|track|wholesale|career|job|review|testimonial|warranty|guarantee|affiliate|partner)/i;

/** Cuts at the last whole word that fits, without a dangling comma or dash. */
export function trimWords(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : t.slice(0, max))
    .replace(/[\s,;:|·\-–—&]+$/, "")
    .replace(/\s+(?:and|or|with|for|the|of|to|in|a|an|&)$/i, "")
    .replace(/[\s,;:|·\-–—&]+$/, "");
}

// ---------- Search Console ----------

async function gsc<T>(conn: Connection, body: Record<string, unknown>): Promise<T> {
  return googleRequest<T>(
    { kind: "oauth", refreshToken: conn.refreshToken },
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(conn.gscSiteUrl!)}/searchAnalytics/query`,
    body
  );
}

export interface PageShare {
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** Every page of the site Google showed for a search in the last 28 days, strongest first. */
export async function pagesForQuery(conn: Connection, query: string): Promise<PageShare[]> {
  const { current } = resolveRange("28d", 3);
  const d = await gsc<{ rows?: { keys: string[]; clicks: number; impressions: number; position: number }[] }>(conn, {
    startDate: current.start,
    endDate: current.end,
    dimensions: ["page"],
    dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "equals", expression: query }] }],
    rowLimit: 25,
  });
  return (d.rows ?? [])
    .map((r) => ({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.position - b.position);
}

/**
 * The page to work on for a search when several of the site's pages compete
 * for it: the one with the most clicks, then impressions. Null when the given
 * page is the stronger one or has no real rival (a rival needs at least a
 * fifth of the impressions).
 */
export function strongerRival(page: string, shares: PageShare[]): PageShare | null {
  const mine = shares.find((s) => s.page === page);
  const top = shares[0];
  if (!top || top.page === page) return null;
  if (mine && top.clicks === mine.clicks && top.impressions <= mine.impressions) return null;
  return top.impressions >= (mine?.impressions ?? 0) * 0.2 ? top : null;
}

export interface Cannibal {
  query: string;
  pages: PageShare[];
}

/** Searches where two or more of the site's pages each get real impressions (last 28 days). */
export async function cannibalizedQueries(conn: Connection, brand: string): Promise<Cannibal[]> {
  const { current } = resolveRange("28d", 3);
  const d = await gsc<{ rows?: { keys: string[]; clicks: number; impressions: number; position: number }[] }>(conn, {
    startDate: current.start,
    endDate: current.end,
    dimensions: ["query", "page"],
    rowLimit: 5000,
  });
  const by = new Map<string, PageShare[]>();
  for (const r of d.rows ?? []) {
    const [query, page] = r.keys;
    if (brand && query.includes(brand)) continue;
    if (r.impressions < 5 || new URL(page).hash) continue;
    by.set(query, [...(by.get(query) ?? []), { page, clicks: r.clicks, impressions: r.impressions, position: r.position }]);
  }
  return [...by]
    .filter(([, pages]) => pages.length > 1)
    .map(([query, pages]) => ({ query, pages: pages.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions) }))
    .sort((a, b) => b.pages.reduce((s, p) => s + p.impressions, 0) - a.pages.reduce((s, p) => s + p.impressions, 0))
    .slice(0, 25);
}

export interface TrafficCheck {
  recentWeek: number;
  usualWeek: number;
  /** Fraction lost, 0.5 = half. */
  drop: number;
  sharp: boolean;
}

/** Last 7 days of Google clicks against the 4 weeks before. Sharp: down 40% or more from a usual week of 20+ clicks. */
export async function trafficCheck(conn: Connection): Promise<TrafficCheck> {
  const end = new Date(Date.now() - 3 * 864e5);
  const start = new Date(end.getTime() - 34 * 864e5);
  const d = await gsc<{ rows?: { keys: string[]; clicks: number }[] }>(conn, {
    startDate: toIso(start),
    endDate: toIso(end),
    dimensions: ["date"],
    rowLimit: 100,
  });
  const cutoff = toIso(new Date(end.getTime() - 6 * 864e5));
  const rows = d.rows ?? [];
  const recentWeek = rows.filter((r) => r.keys[0] >= cutoff).reduce((s, r) => s + r.clicks, 0);
  const usualWeek = rows.filter((r) => r.keys[0] < cutoff).reduce((s, r) => s + r.clicks, 0) / 4;
  const drop = usualWeek ? Math.max(0, 1 - recentWeek / usualWeek) : 0;
  return { recentWeek, usualWeek: Math.round(usualWeek), drop, sharp: usualWeek >= 20 && drop >= 0.4 };
}
