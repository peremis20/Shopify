import { ensureSchema, sql } from "../db";
import { getBody, setBody, shopifyGql, type StoreAccess } from "./shopify";

/**
 * Link fixer. When a product is renamed, Shopify redirects its old address,
 * but blog posts and pages keep linking to the old one, so every click and
 * every bit of link credit goes through a redirect first. Once a week this
 * finds links to product addresses that no longer exist, asks the live store
 * where each one redirects, and points the link straight at the live product.
 * Only the address inside the link changes; the wording stays as written.
 */

const RECHECK_DAYS = 7;
const settingKey = (accountId: string) => `linkfix_checked:${accountId}`;

/** href="/products/x", href="https://shop.com/products/x?variant=1", single or double quotes. */
const PRODUCT_LINK = /(href=(["'])(?:https?:\/\/([^"'/]+))?\/products\/)([a-z0-9][a-z0-9-]*)(?=[?#"'])/gi;

interface Item {
  type: "article" | "page";
  id: string;
  url: string;
  body: string;
}

export async function paged<N>(s: StoreAccess, field: "articles" | "pages" | "products" | "collections", nodeFields: string): Promise<N[]> {
  const out: N[] = [];
  let after: string | null = null;
  for (let i = 0; i < 20; i++) {
    const d: Record<string, { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> = await shopifyGql(
      s,
      `query($after: String) { ${field}(first: 100, after: $after) { nodes { ${nodeFields} } pageInfo { hasNextPage endCursor } } }`,
      { after }
    );
    out.push(...d[field].nodes);
    if (!d[field].pageInfo.hasNextPage) break;
    after = d[field].pageInfo.endCursor;
  }
  return out;
}

async function storeItems(s: StoreAccess): Promise<Item[]> {
  const [articles, pages] = await Promise.all([
    paged<{ id: string; handle: string; body: string | null; blog: { handle: string } }>(s, "articles", "id handle body blog { handle }"),
    paged<{ id: string; handle: string; body: string | null }>(s, "pages", "id handle body"),
  ]);
  return [
    ...articles.map((a) => ({ type: "article" as const, id: a.id, url: `/blogs/${a.blog.handle}/${a.handle}`, body: a.body ?? "" })),
    ...pages.map((p) => ({ type: "page" as const, id: p.id, url: `/pages/${p.handle}`, body: p.body ?? "" })),
  ];
}

/** Where an old product address ends up, following the store's own redirects. Null when it isn't a live product. */
async function liveTarget(origin: string, handle: string, live: Set<string>): Promise<string | null> {
  let path = `/products/${handle}`;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(origin + path, { redirect: "manual" }).catch(() => null);
    await res?.body?.cancel().catch(() => undefined);
    const to = res?.headers.get("location");
    if (!res || res.status < 300 || res.status >= 400 || !to) return null;
    path = new URL(to, origin + path).pathname;
    const m = path.match(/^\/products\/([a-z0-9-]+)\/?$/i);
    if (m && live.has(m[1].toLowerCase())) return m[1].toLowerCase();
    if (!m) return null;
  }
  return null;
}

/** Links to this store: relative ones, or full ones on one of its domains (never another site's /products/ page). */
const ours = (host: string | undefined, hosts: Set<string>) => !host || hosts.has(host.toLowerCase().replace(/^www\./, ""));

/** Rewrites product links using the map; returns the new body and how many links changed. */
export function rewriteLinks(body: string, map: Map<string, string>, hosts: Set<string>): { body: string; changed: number } {
  let changed = 0;
  const out = body.replace(PRODUCT_LINK, (whole, start: string, _q: string, host: string | undefined, handle: string) => {
    const to = map.get(handle.toLowerCase());
    if (!to || !ours(host, hosts)) return whole;
    changed++;
    return start + to;
  });
  return { body: out, changed };
}

export interface LinkFix {
  type: "article" | "page";
  id: string;
  url: string;
  before: string;
  after: string;
  links: { from: string; to: string; count: number }[];
}

/** Finds the fixes without changing anything. */
export async function findLinkFixes(s: StoreAccess): Promise<LinkFix[]> {
  const [items, products, shop] = await Promise.all([
    storeItems(s),
    paged<{ handle: string; status: string }>(s, "products", "handle status"),
    shopifyGql<{ shop: { primaryDomain: { url: string } } }>(s, "{ shop { primaryDomain { url } } }"),
  ]);
  const origin = new URL(shop.shop.primaryDomain.url).origin;
  const hosts = new Set([new URL(origin).hostname.replace(/^www\./, ""), s.shopDomain]);
  const live = new Set(products.filter((p) => p.status === "ACTIVE").map((p) => p.handle.toLowerCase()));
  const old = new Set<string>();
  for (const it of items) {
    for (const m of it.body.matchAll(PRODUCT_LINK)) if (ours(m[3], hosts) && !live.has(m[4].toLowerCase())) old.add(m[4].toLowerCase());
  }

  const map = new Map<string, string>();
  for (const h of old) {
    const to = await liveTarget(origin, h, live);
    if (to && to !== h) map.set(h, to);
  }
  if (!map.size) return [];

  const fixes: LinkFix[] = [];
  for (const it of items) {
    const { body, changed } = rewriteLinks(it.body, map, hosts);
    if (!changed) continue;
    const counts = new Map<string, number>();
    for (const m of it.body.matchAll(PRODUCT_LINK)) {
      const h = m[4].toLowerCase();
      if (map.has(h) && ours(m[3], hosts)) counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    fixes.push({
      ...it,
      before: it.body,
      after: body,
      links: [...counts].map(([from, count]) => ({ from, to: map.get(from)!, count })),
    });
  }
  return fixes;
}

export function describeFix(f: LinkFix): string {
  const n = f.links.reduce((a, l) => a + l.count, 0);
  const parts = f.links.map((l) => `/products/${l.to} (was /products/${l.from})`);
  return `Pointed ${n} link${n === 1 ? "" : "s"} straight at ${parts.join(", ")}.`;
}

/** Saves one fix, only if the body hasn't changed since it was read. */
export async function applyLinkFix(s: StoreAccess, f: LinkFix): Promise<boolean> {
  if ((await getBody(s, f.type, f.id)) !== f.before) return false;
  await setBody(s, f.type, f.id, f.after);
  return true;
}

/** Undo: puts the old body back if nobody edited the post since. */
export async function undoLinkFix(s: StoreAccess, type: "article" | "page", id: string, before: string, after: string): Promise<boolean> {
  if ((await getBody(s, type, id)) !== after) return false;
  await setBody(s, type, id, before);
  return true;
}

export async function linkFixDue(accountId: string): Promise<boolean> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${settingKey(accountId)}`;
  return !row?.value || Date.now() - Number(row.value) > RECHECK_DAYS * 864e5;
}

export async function markLinkFixChecked(accountId: string): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${settingKey(accountId)}, ${String(Date.now())})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
