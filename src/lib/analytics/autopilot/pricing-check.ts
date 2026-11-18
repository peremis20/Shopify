import { shopifyGql, type StoreAccess } from "./shopify";

/**
 * The pricing check, part of the weekly store audit (store-audit.ts): it reads the store's own catalog and asks
 * whether its packs and bundles make sense next to its single items, and whether each crossed out price is honest.
 *
 * - A pack of one item ("2 Pack", "3 Bottles", "2 Bottle Bundle") is matched to its single item by SKU ("ABC-2PK"
 *   to "ABC", only when the count in the SKU is the count in the name) or by the same product's single option. A
 *   mixed bundle is matched to its items only when its SKU lists their SKUs ("ABC,DEF" or "ABC+DEF"): nothing is
 *   guessed from names alone.
 * - Flags: a pack or bundle that saves nothing or very little against buying the items one by one, a bigger pack that
 *   costs more per item than a smaller one, a pack of one item that costs more than a mixed bundle of the same size,
 *   a crossed out price on a pack or bundle that isn't the items' own prices added up, and a crossed out price on a
 *   single item that no order the app could read was charged (said with the real dates read).
 * - Rules only, from the store's own numbers; no AI writes or judges anything here, so nothing can be invented.
 * - The app never changes a price. A crossed out price it can set right is offered to the owner as an Apply button
 *   (their click is the approval), and every change it makes is kept, so it can be undone even weeks later.
 */

export interface CatalogVariant {
  productId: string;
  productTitle: string;
  handle: string;
  variantId: string;
  variantTitle: string;
  sku: string;
  /** Prices in cents. */
  price: number;
  compareAt: number | null;
}

export interface Catalog {
  currency: string;
  variants: CatalogVariant[];
  /** More products than were read: the check covers the first ones. */
  capped: boolean;
}

/** The highest unit price each variant was charged in the orders read, in cents, and which dates those orders cover. */
export interface SoldPrices {
  top: Map<string, number>;
  /** The oldest order read (ISO date), or null when there were none. */
  since: string | null;
}

export type PriceKind = "no-saving" | "small-saving" | "ladder" | "pack-vs-mix" | "compare-at-sum" | "compare-at-missing" | "compare-at-never-charged";

export interface PriceFinding {
  /** Stable across runs: what the finding is about, never its place in the list. */
  id: string;
  kind: PriceKind;
  product: string;
  option: string | null;
  page: string;
  problem: string;
  fix: string;
  impact: "high" | "medium" | "low";
  /** A crossed out price change the owner can apply with one click. */
  apply?: { productId: string; variantId: string; price: number; compareAtBefore: number | null; compareAtAfter: number | null };
}

/** A change the owner applied, kept across weekly checks so it can always be undone. */
export interface AppliedChange {
  id: string;
  /** The check the change was made from. */
  checkAt: string;
  label: string;
  productId: string;
  variantId: string;
  price: number;
  before: number | null;
  after: number | null;
  at: string;
}

export interface PricingCheck {
  at: string;
  currency: string;
  findings: PriceFinding[];
  /** Every crossed out price the owner changed from here, newest last (see store-audit.ts). */
  applied?: AppliedChange[];
  /** Variants checked, packs and bundles matched to their items. */
  checked: { variants: number; packs: number; bundles: number };
  /** Whether order history was read for the crossed out price check (it needs permission to read orders). */
  orders: "read" | "no-access" | "failed" | "none" | "too-few";
  note: string;
}

// ---------- reading the catalog ----------

const cents = (amount: string | null | undefined) => {
  if (amount === null || amount === undefined || amount === "") return null;
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** Products per catalog request: 15 products of up to 50 options stays under Shopify's 1,000 point limit per query. */
const PRODUCTS_PER_PAGE = 15;
const PRODUCT_PAGES = 34;

/** The store's active products and their options, up to about 500 products. */
export async function readCatalog(store: StoreAccess): Promise<Catalog> {
  const out: Catalog = { currency: "USD", variants: [], capped: false };
  let after: string | null = null;
  for (let page = 0; page < PRODUCT_PAGES; page++) {
    const d: {
      shop: { currencyCode: string };
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { id: string; title: string; handle: string; variants: { nodes: { id: string; title: string; sku: string | null; price: string; compareAtPrice: string | null }[] } }[];
      };
    } = await shopifyGql(
      store,
      `query($after: String) { shop { currencyCode } products(first: ${PRODUCTS_PER_PAGE}, after: $after, query: "status:active") { pageInfo { hasNextPage endCursor }
        nodes { id title handle variants(first: 50) { nodes { id title sku price compareAtPrice } } } } }`,
      { after },
    );
    out.currency = d.shop.currencyCode || out.currency;
    for (const p of d.products.nodes)
      for (const v of p.variants.nodes) {
        const price = cents(v.price);
        if (price === null) continue;
        out.variants.push({
          productId: p.id,
          productTitle: p.title,
          handle: p.handle,
          variantId: v.id,
          variantTitle: v.title,
          sku: (v.sku ?? "").trim(),
          price,
          compareAt: cents(v.compareAtPrice),
        });
      }
    if (!d.products.pageInfo.hasNextPage) break;
    if (page === PRODUCT_PAGES - 1) out.capped = true;
    after = d.products.pageInfo.endCursor;
  }
  return out;
}

/** Orders per request: 20 orders of up to 20 lines stays under Shopify's 1,000 point limit per query. */
const ORDERS_PER_PAGE = 20;
const ORDER_PAGES = 25;

/**
 * The highest unit price each variant was charged (before discounts) in the store's recent orders, newest first, up to
 * 500 orders of the last year. Shopify only lets the app read the last 60 days unless the store allows more, so the
 * dates actually covered are returned with it.
 */
export async function soldPrices(store: StoreAccess, days = 365): Promise<SoldPrices> {
  const fromDate = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const out: SoldPrices = { top: new Map(), since: null };
  let after: string | null = null;
  for (let page = 0; page < ORDER_PAGES; page++) {
    const d: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { test: boolean; createdAt: string; lineItems: { nodes: { variant: { id: string } | null; originalUnitPriceSet: { shopMoney: { amount: string } } }[] } }[];
      };
    } = await shopifyGql(
      store,
      `query($q: String!, $after: String) { orders(first: ${ORDERS_PER_PAGE}, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) { pageInfo { hasNextPage endCursor }
        nodes { test createdAt lineItems(first: 20) { nodes { variant { id } originalUnitPriceSet { shopMoney { amount } } } } } } }`,
      { q: `created_at:>=${fromDate}`, after },
    );
    for (const o of d.orders.nodes) {
      out.since = o.createdAt;
      if (o.test) continue;
      for (const li of o.lineItems.nodes) {
        const c = cents(li.originalUnitPriceSet.shopMoney.amount);
        if (!li.variant || c === null) continue;
        out.top.set(li.variant.id, Math.max(out.top.get(li.variant.id) ?? 0, c));
      }
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

// ---------- matching packs and bundles to their items ----------

/** Words that count items in a pack; capsules, counts and sizes inside one item never do. */
const PACK = /\b(\d{1,2})\s*(?:x\s*)?(?:packs?|pk|bottles?|jars?|bags?|boxes|tubs?|cans?|units?|pieces?|pcs)\b|\b(?:pack|set|bundle|box) of (\d{1,2})\b/i;

/** How many of one item an option holds: from its own name, or for a single option product, from the product name. */
export function unitsOf(variantTitle: string, productTitle: string, onlyOption: boolean): number {
  const read = (s: string) => {
    const m = s.match(PACK);
    const n = m ? Number(m[1] ?? m[2]) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 24 ? n : null;
  };
  const own = /^default title$/i.test(variantTitle.trim()) ? null : read(variantTitle);
  if (own !== null) return own;
  return onlyOption ? (read(productTitle) ?? 1) : 1;
}

/**
 * Every way a pack SKU can name its single item and a count: "ABC-2PK" or "ABC-3PACK" or "ABC-X2" gives "ABC" and 2
 * or 3. Longest base first, so "10012PK" reads as "1001" times 2 before "100" times 12.
 */
export function skuSplits(sku: string): { base: string; units: number }[] {
  const out: { base: string; units: number }[] = [];
  for (let i = sku.length - 1; i >= 1; i--) {
    const rest = sku.slice(i);
    const m = rest.match(/^[-_ ]?(\d{1,2})\s*(?:PK|PACK|P|X)$/i) ?? rest.match(/^[-_ ]?X(\d{1,2})$/i);
    if (!m) continue;
    const base = sku.slice(0, i).replace(/[-_ ]+$/, "");
    if (base && !out.some((o) => o.base === base)) out.push({ base, units: Number(m[1]) });
  }
  return out;
}

/** The SKUs a mixed bundle lists: "ABC,DEF" or "ABC + DEF" (two or more, so "SPF50+" is one item, not a list). */
export const listedSkus = (sku: string) => {
  const parts = /[,+]/.test(sku) ? sku.split(/\s*[,+]\s*/).filter(Boolean) : [];
  return parts.length >= 2 ? parts : [];
};

export interface Pack {
  v: CatalogVariant;
  single: CatalogVariant;
  units: number;
}
export interface Mix {
  v: CatalogVariant;
  items: CatalogVariant[];
}

/** Packs of one item and mixed bundles, each matched to paid single items for certain. */
export function matchCatalog(variants: CatalogVariant[]): { singles: CatalogVariant[]; packs: Pack[]; mixes: Mix[] } {
  const optionCount = new Map<string, number>();
  for (const v of variants) optionCount.set(v.productId, (optionCount.get(v.productId) ?? 0) + 1);
  const units = new Map(variants.map((v) => [v.variantId, listedSkus(v.sku).length ? 0 : unitsOf(v.variantTitle, v.productTitle, optionCount.get(v.productId) === 1)]));
  // A free item (a sample) is never a price to compare against.
  const singles = variants.filter((v) => units.get(v.variantId) === 1 && v.price > 0);
  const bySku = new Map<string, CatalogVariant>();
  for (const s of singles) if (s.sku) bySku.set(s.sku.toLowerCase(), s);
  const packs: Pack[] = [];
  const mixes: Mix[] = [];
  for (const v of variants) {
    const listed = listedSkus(v.sku);
    if (listed.length) {
      const items = listed.map((s) => bySku.get(s.toLowerCase()));
      if (items.every(Boolean)) mixes.push({ v, items: items as CatalogVariant[] });
      continue;
    }
    const n = units.get(v.variantId) ?? 1;
    if (n < 2) continue;
    // By SKU, only when the count in the SKU is the count in the name.
    const bySplit = v.sku ? skuSplits(v.sku).find((s) => s.units === n && bySku.has(s.base.toLowerCase())) : undefined;
    const single =
      (bySplit ? bySku.get(bySplit.base.toLowerCase()) : undefined) ??
      // The same product's single option, when it has exactly one.
      (() => {
        const same = singles.filter((s) => s.productId === v.productId);
        return same.length === 1 ? same[0] : undefined;
      })();
    if (single && single.variantId !== v.variantId) packs.push({ v, single, units: n });
  }
  return { singles, packs, mixes };
}

// ---------- the checks ----------

/** A saving under this share (10%) is too small for a shopper to notice. Compared in whole cents. */
export const SMALL_SAVING_PCT = 10;
/** Order history must cover at least this many days before a crossed out price is called one never charged. */
export const MIN_ORDER_DAYS = 28;

const money = (c: number, currency: string) => {
  const sym: Record<string, string> = { USD: "$", CAD: "$", AUD: "$", NZD: "$", EUR: "€", GBP: "£" };
  const n = (c / 100).toFixed(2);
  return sym[currency] ? `${sym[currency]}${n}` : `${n} ${currency}`;
};
const pct = (saved: number, of: number) => `${Math.round((saved * 100) / of)}%`;
export const variantLabel = (v: Pick<CatalogVariant, "productTitle" | "variantTitle">) => (/^default title$/i.test(v.variantTitle) ? v.productTitle : `${v.productTitle}, ${v.variantTitle}`);
const pageOf = (origin: string, v: CatalogVariant) => `${origin}/products/${v.handle}`;
/** A crossed out price a theme actually shows: above the price. */
const shownCompareAt = (v: CatalogVariant) => (v.compareAt !== null && v.compareAt > v.price ? v.compareAt : null);
const shortId = (gid: string) => gid.split("/").pop() ?? gid;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A price ending the way the store's other prices end (most often .99), a little under the target. */
function storePrice(target: number, endings: number[]): number {
  const end = endings.length ? mode(endings) : 99;
  let p = Math.floor(target / 100) * 100 + end;
  if (p > target) p -= 100;
  return Math.max(p, 1);
}
const mode = (xs: number[]) => {
  const n = new Map<number, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

/**
 * Every pricing finding for one catalog, most important first. `sold` is null when order history wasn't read; `now`
 * decides whether the orders read cover enough days.
 */
export function checkPricing(catalog: Catalog, origin: string, sold: SoldPrices | null, now = Date.now()): PriceFinding[] {
  const { singles, packs, mixes } = matchCatalog(catalog.variants);
  const cur = catalog.currency;
  const endings = catalog.variants.filter((v) => v.price > 0).map((v) => v.price % 100);
  const out: PriceFinding[] = [];
  const base = (kind: PriceKind, v: CatalogVariant, extra = "") => ({
    id: `${kind}:${shortId(v.variantId)}${extra ? `:${extra}` : ""}`,
    kind,
    product: v.productTitle,
    option: /^default title$/i.test(v.variantTitle) ? null : v.variantTitle,
    page: pageOf(origin, v),
  });

  // A pack or bundle against buying its items one by one, and its crossed out price against their prices added up.
  const groups: { v: CatalogVariant; sum: number; what: string }[] = [
    ...packs.map((p) => ({ v: p.v, sum: p.single.price * p.units, what: `${p.units} single ${p.single.productTitle}` })),
    ...mixes.map((m) => ({ v: m.v, sum: m.items.reduce((s, i) => s + i.price, 0), what: m.items.map((i) => i.productTitle).join(" and ") + " bought one by one" })),
  ];
  for (const g of groups) {
    if (g.sum <= 0) continue;
    const saved = g.sum - g.v.price;
    const target = storePrice(Math.round((g.sum * 85) / 100), endings);
    if (saved <= 0)
      out.push({
        ...base("no-saving", g.v),
        problem: `${variantLabel(g.v)} costs ${money(g.v.price, cur)}, the same as or more than ${g.what} (${money(g.sum, cur)}).`,
        fix: `Price it below ${money(g.sum, cur)}, for example ${money(target, cur)} (about 15% off), so buying more saves money.`,
        impact: "high",
      });
    else if (saved * 100 < g.sum * SMALL_SAVING_PCT)
      out.push({
        ...base("small-saving", g.v),
        problem: `${variantLabel(g.v)} saves only ${money(saved, cur)} (${pct(saved, g.sum)}) against ${g.what} (${money(g.sum, cur)}).`,
        fix: `A saving under 10% is easy to miss. Something like ${money(target, cur)} (about 15% off) makes it worth choosing.`,
        impact: "medium",
      });
    const shown = shownCompareAt(g.v);
    if (shown !== null && shown !== g.sum)
      out.push({
        ...base("compare-at-sum", g.v),
        problem: `${variantLabel(g.v)} shows a crossed out price of ${money(shown, cur)}, but ${g.what} cost ${money(g.sum, cur)}.`,
        fix:
          shown > g.sum
            ? `Set the crossed out price to ${money(g.sum, cur)}, what the items really cost on their own, so the saving shown is the real one.`
            : `Set the crossed out price to ${money(g.sum, cur)}, what the items cost on their own, so shoppers see the full saving.`,
        impact: shown > g.sum ? "medium" : "low",
        ...(saved > 0 ? { apply: { productId: g.v.productId, variantId: g.v.variantId, price: g.v.price, compareAtBefore: g.v.compareAt, compareAtAfter: g.sum } } : {}),
      });
    else if (shown === null && saved > 0)
      out.push({
        ...base("compare-at-missing", g.v),
        problem: `${variantLabel(g.v)} doesn't show what the items cost on their own (${money(g.sum, cur)}), so the saving is hidden.`,
        fix: `Show ${money(g.sum, cur)} as the crossed out price.`,
        impact: "low",
        apply: { productId: g.v.productId, variantId: g.v.variantId, price: g.v.price, compareAtBefore: g.v.compareAt, compareAtAfter: g.sum },
      });
  }

  // A bigger pack of the same item should never cost more per item than a smaller one (compared in whole cents).
  const bySingle = new Map<string, Pack[]>();
  for (const p of packs) bySingle.set(p.single.variantId, [...(bySingle.get(p.single.variantId) ?? []), p]);
  for (const list of bySingle.values()) {
    const sorted = [...list].sort((a, b) => a.units - b.units);
    for (let i = 1; i < sorted.length; i++) {
      const small = sorted[i - 1];
      const big = sorted[i];
      if (big.units === small.units) continue;
      if (big.v.price * small.units > small.v.price * big.units)
        out.push({
          ...base("ladder", big.v, shortId(small.v.variantId)),
          problem: `${variantLabel(big.v)} costs ${money(Math.round(big.v.price / big.units), cur)} per item, more than ${variantLabel(small.v)} (${money(Math.round(small.v.price / small.units), cur)} per item).`,
          fix: `Price the bigger pack so each item costs less than in the smaller one.`,
          impact: "medium",
        });
    }
  }

  // A pack of one item should never cost more than a mixed bundle of the same size that holds that item and costs at
  // least as much one by one.
  for (const p of packs)
    for (const m of mixes) {
      if (m.items.length !== p.units || !m.items.some((i) => i.variantId === p.single.variantId)) continue;
      const mixSum = m.items.reduce((s, i) => s + i.price, 0);
      if (mixSum >= p.single.price * p.units && p.v.price > m.v.price)
        out.push({
          ...base("pack-vs-mix", p.v, shortId(m.v.variantId)),
          problem: `${variantLabel(p.v)} costs ${money(p.v.price, cur)}, more than the ${m.v.productTitle} (${money(m.v.price, cur)}), which holds the same item and costs as much or more one by one.`,
          fix: `Price ${variantLabel(p.v)} at or below ${money(m.v.price, cur)}.`,
          impact: "high",
        });
    }

  // A single item's crossed out price should be one the store really charged, judged only on the dates actually read.
  const covers = sold?.since && sold.top.size && now - Date.parse(sold.since) >= MIN_ORDER_DAYS * 864e5;
  if (sold && covers)
    for (const s of singles) {
      const shown = shownCompareAt(s);
      if (shown === null) continue;
      const top = sold.top.get(s.variantId);
      if (top !== undefined && top >= shown) continue;
      out.push({
        ...base("compare-at-never-charged", s),
        problem: `${variantLabel(s)} shows a crossed out price of ${money(shown, cur)}, but no order since ${day(sold.since!)} was charged that${top !== undefined ? ` (the highest was ${money(top, cur)})` : ""}.`,
        fix: `A crossed out price should be one the store really charged. If it wasn't charged before then either, remove it or set it to a price you sold at.`,
        impact: "medium",
        apply: { productId: s.productId, variantId: s.variantId, price: s.price, compareAtBefore: s.compareAt, compareAtAfter: null },
      });
    }

  const rank: Record<PriceFinding["impact"], number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.impact] - rank[b.impact]);
}

/** A one line summary of a check. */
export function pricingNote(c: Pick<PricingCheck, "findings" | "checked" | "orders">): string {
  const n = c.findings.length;
  const what = `${c.checked.packs} ${c.checked.packs === 1 ? "pack" : "packs"} and ${c.checked.bundles} ${c.checked.bundles === 1 ? "bundle" : "bundles"} checked`;
  const orders =
    c.orders === "no-access"
      ? ". Crossed out prices weren't checked against orders: the app may not read orders yet."
      : c.orders === "failed"
        ? ". Orders couldn't be read, so crossed out prices weren't checked against them."
        : c.orders === "too-few"
          ? ". The orders the app can read cover too few days to judge crossed out prices."
          : "";
  return `${what}, ${n ? `${n} ${n === 1 ? "price to fix" : "prices to fix"}` : "nothing to fix"}${orders}`;
}

/** The whole pricing check of one Shopify store. Throws when the catalog can't be read (the store audit reports it). */
export async function runPricingCheck(store: StoreAccess, origin: string): Promise<PricingCheck> {
  const { needsOrderAccess } = await import("./shopify-sales");
  const catalog = await readCatalog(store);
  let orders: PricingCheck["orders"] = "read";
  const sold = await soldPrices(store).catch((e) => {
    orders = needsOrderAccess(e) ? "no-access" : "failed";
    if (orders === "failed") console.error(`pricing check: orders not read for ${store.shopDomain}: ${(e as Error).message}`);
    return null;
  });
  if (sold && !sold.top.size) orders = "none";
  else if (sold?.since && Date.now() - Date.parse(sold.since) < MIN_ORDER_DAYS * 864e5) orders = "too-few";
  const m = matchCatalog(catalog.variants);
  const findings = checkPricing(catalog, origin, sold);
  const checked = { variants: catalog.variants.length, packs: m.packs.length, bundles: m.mixes.length };
  return { at: new Date().toISOString(), currency: catalog.currency, findings, checked, orders, note: pricingNote({ findings, checked, orders }) };
}

// ---------- the owner's Apply and Undo ----------

const fmtAmount = (c: number | null) => (c === null ? null : (c / 100).toFixed(2));

/**
 * Sets one variant's crossed out price, only when its price and crossed out price are still what was seen (so a change
 * made since is never overwritten). Returns why not, or null when done.
 */
export async function setCompareAt(store: StoreAccess, a: { productId: string; variantId: string; price: number; from: number | null; to: number | null }): Promise<string | null> {
  const d = await shopifyGql<{ productVariant: { price: string; compareAtPrice: string | null; product: { id: string } } | null }>(
    store,
    `query($id: ID!) { productVariant(id: $id) { price compareAtPrice product { id } } }`,
    { id: a.variantId },
  );
  const v = d.productVariant;
  if (!v || v.product.id !== a.productId) return "That product isn't in the store anymore.";
  if (cents(v.price) !== a.price || cents(v.compareAtPrice) !== a.from) return "The price changed since the check. Run the store audit again first.";
  await shopifyGql(
    store,
    `mutation($p: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $p, variants: $v) { userErrors { field message } } }`,
    { p: a.productId, v: [{ id: a.variantId, compareAtPrice: fmtAmount(a.to) }] },
  );
  return null;
}
