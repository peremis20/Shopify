import { ensureSchema, sql } from "../db";
import { hasDisclaimer, scanClaims, type ClaimFlag } from "./claims";
import { paged } from "./link-fixer";
import { shopifyGql, type StoreAccess } from "./shopify";

/**
 * Weekly claim check of the whole store: every blog post, page and active
 * product description goes through the claim guard, and product pages are
 * checked for the FDA disclaimer (unless the theme shows it on every page).
 * Read only: findings are shown with a safer wording to apply by hand.
 */

const RECHECK_DAYS = 7;
const settingKey = (accountId: string) => `claims_checked:${accountId}`;

export interface ClaimPage {
  url: string;
  title: string;
  kind: "article" | "page" | "product";
  flags: ClaimFlag[];
}

export interface ClaimReport {
  checkedAt: string | null;
  scanned: number;
  pages: ClaimPage[];
}

const MISSING_DISCLAIMER: ClaimFlag = {
  level: "medium",
  phrase: "No FDA disclaimer",
  excerpt: "",
  why: "Supplement pages that describe how a product supports the body need the FDA disclaimer, and it isn't on this page or in the theme footer.",
  fix: 'Add: "These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease."',
};

export async function claimScanDue(accountId: string): Promise<boolean> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${settingKey(accountId)}`;
  return !row?.value || Date.now() - Number(row.value) > RECHECK_DAYS * 864e5;
}

/** Scans the store and replaces the stored findings. Returns how many items have flags. */
export async function scanStoreClaims(accountId: string, s: StoreAccess): Promise<number> {
  const [articles, pages, products, shop] = await Promise.all([
    paged<{ handle: string; title: string; body: string | null; isPublished: boolean; blog: { handle: string } }>(s, "articles", "handle title body isPublished blog { handle }"),
    paged<{ handle: string; title: string; body: string | null; isPublished: boolean }>(s, "pages", "handle title body isPublished"),
    paged<{ handle: string; title: string; descriptionHtml: string | null; status: string }>(s, "products", "handle title descriptionHtml status"),
    shopifyGql<{ shop: { primaryDomain: { url: string } } }>(s, "{ shop { primaryDomain { url } } }"),
  ]);
  const origin = new URL(shop.shop.primaryDomain.url).origin;
  // Many themes put the disclaimer in the footer, which covers every page.
  const home = await fetch(origin, { headers: { "User-Agent": "Mozilla/5.0 (compatible; RankingOS/1.0)" } })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  const sitewide = hasDisclaimer(home);

  const found: ClaimPage[] = [];
  const check = (kind: ClaimPage["kind"], url: string, title: string, html: string) => {
    const flags = scanClaims(html);
    if (kind === "product" && !sitewide && !hasDisclaimer(html) && /\bsupports?\b|\bpromotes?\b|\bhelps?\b/i.test(html)) flags.push(MISSING_DISCLAIMER);
    if (flags.length) found.push({ kind, url: origin + url, title, flags });
  };
  for (const a of articles) if (a.isPublished) check("article", `/blogs/${a.blog.handle}/${a.handle}`, a.title, a.body ?? "");
  for (const p of pages) if (p.isPublished) check("page", `/pages/${p.handle}`, p.title, p.body ?? "");
  for (const p of products) if (p.status === "ACTIVE") check("product", `/products/${p.handle}`, p.title, p.descriptionHtml ?? "");

  await sql`DELETE FROM insights_claim_flags WHERE account_id = ${accountId}`;
  for (const f of found) {
    await sql`
      INSERT INTO insights_claim_flags (account_id, url, title, kind, flags)
      VALUES (${accountId}, ${f.url}, ${f.title}, ${f.kind}, ${JSON.stringify(f.flags)}::jsonb)`;
  }
  const scanned = articles.filter((a) => a.isPublished).length + pages.filter((p) => p.isPublished).length + products.filter((p) => p.status === "ACTIVE").length;
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${settingKey(accountId)}, ${String(Date.now())}), (${`claims_scanned:${accountId}`}, ${String(scanned)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return found.length;
}

export async function claimReport(accountId: string): Promise<ClaimReport> {
  await ensureSchema();
  const rows = await sql`SELECT url, title, kind, flags FROM insights_claim_flags WHERE account_id = ${accountId}`;
  const meta = await sql`SELECT key, value FROM insights_settings WHERE key IN (${settingKey(accountId)}, ${`claims_scanned:${accountId}`})`;
  const val = (k: string) => meta.find((m) => m.key === k)?.value ?? null;
  const checked = val(settingKey(accountId));
  const pages = rows.map((r) => ({
    url: r.url!,
    title: r.title!,
    kind: r.kind as ClaimPage["kind"],
    flags: (typeof r.flags === "string" ? JSON.parse(r.flags) : r.flags) as ClaimFlag[],
  }));
  const weight = (p: ClaimPage) => p.flags.filter((f) => f.level === "high").length * 10 + p.flags.length;
  return {
    checkedAt: checked ? new Date(Number(checked)).toISOString() : null,
    scanned: Number(val(`claims_scanned:${accountId}`) ?? 0),
    pages: pages.sort((a, b) => weight(b) - weight(a)),
  };
}
