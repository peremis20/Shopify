import { shopifyGql, type StoreAccess } from "./shopify";

/**
 * Sales straight from Shopify, with where each buyer came from (Shopify's own customer journey for the order), so
 * the agents know which pages bring sales from Google even when Google Analytics doesn't receive purchases. Needs
 * permission to read orders; without it this says so plainly (the owner reconnects Shopify once).
 */

export interface ShopifySales {
  days: number;
  orders: number;
  revenue: number;
  currency: string | null;
  /** Orders whose visit came from Google search (not ads). */
  fromGoogle: number;
  fromGoogleRevenue: number;
  /** More orders than were read (over 1,000 in the period): the totals are a lower bound. */
  capped?: boolean;
  /** The pages Google search buyers landed on, most orders first. */
  pages: { path: string; orders: number; revenue: number }[];
}

interface Visit {
  source: string | null;
  referrerUrl: string | null;
  landingPage: string | null;
  utmParameters: { medium: string | null } | null;
}

const fromGoogleSearch = (v: Visit | null) => {
  if (!v) return false;
  const paid = /cpc|ppc|paid/i.test(v.utmParameters?.medium ?? "");
  const google = /google/i.test(v.source ?? "") || /^https?:\/\/(www\.)?google\./i.test(v.referrerUrl ?? "");
  return google && !paid;
};

/** Orders of the last `days` days (up to 250), with the Google search share and its landing pages. */
export async function shopifySales(store: StoreAccess, days = 28): Promise<ShopifySales> {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const out: ShopifySales = { days, orders: 0, revenue: 0, currency: null, fromGoogle: 0, fromGoogleRevenue: 0, pages: [] };
  const pages = new Map<string, { orders: number; revenue: number }>();
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const d: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          test: boolean;
          cancelledAt: string | null;
          currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          customerJourneySummary: { firstVisit: Visit | null; lastVisit: Visit | null } | null;
        }[];
      };
    } = await shopifyGql(
      store,
      `query($q: String!, $after: String) { orders(first: 50, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes {
        test cancelledAt currentTotalPriceSet { shopMoney { amount currencyCode } }
        customerJourneySummary {
          firstVisit { source referrerUrl landingPage utmParameters { medium } }
          lastVisit { source referrerUrl landingPage utmParameters { medium } }
        } } } }`,
      { q: `created_at:>=${since}`, after },
    );
    for (const o of d.orders.nodes) {
      if (o.test || o.cancelledAt) continue;
      // After refunds and edits: what the store really kept.
      const amount = Number(o.currentTotalPriceSet.shopMoney.amount) || 0;
      out.orders++;
      out.revenue += amount;
      out.currency ??= o.currentTotalPriceSet.shopMoney.currencyCode;
      const j = o.customerJourneySummary;
      // Credited to Google search when the visit that led to the order (or the first one) came from it.
      const v = fromGoogleSearch(j?.lastVisit ?? null) ? j!.lastVisit : fromGoogleSearch(j?.firstVisit ?? null) ? j!.firstVisit : null;
      if (!v) continue;
      out.fromGoogle++;
      out.fromGoogleRevenue += amount;
      let path = "/";
      try {
        path = v.landingPage ? new URL(v.landingPage, `https://${store.shopDomain}`).pathname : "/";
      } catch {
        /* an unreadable landing page counts as the home page */
      }
      const p = pages.get(path) ?? { orders: 0, revenue: 0 };
      p.orders++;
      p.revenue += amount;
      pages.set(path, p);
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    if (page === 19) out.capped = true;
    after = d.orders.pageInfo.endCursor;
  }
  out.pages = [...pages.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.orders - a.orders || b.revenue - a.revenue).slice(0, 10);
  return out;
}

/** True when the error means the app may not read orders yet (the owner reconnects Shopify to allow it). */
export const needsOrderAccess = (e: unknown) => /access denied|read_orders|scope|not approved|protected customer data/i.test(String((e as Error)?.message ?? e));

/**
 * This site's Shopify sales, kept 6 hours (its own data, keyed by account). "access" when the app may not read
 * orders yet; null for a site that isn't a Shopify store.
 */
export async function salesFor(accountId: string): Promise<ShopifySales | "access" | null> {
  const { sql } = await import("../db");
  const { siteFor } = await import("./site-source");
  const key = `shopsales:${accountId}`;
  const [hit] = await sql`SELECT data FROM insights_report_cache WHERE cache_key = ${key} AND fetched_at > now() - interval '6 hours'`.catch(() => [] as { data: unknown }[]);
  if (hit?.data) return (typeof hit.data === "string" ? JSON.parse(hit.data) : hit.data) as ShopifySales;
  const site = await siteFor(accountId).catch(() => null);
  if (!site?.store) return null;
  try {
    const s = await shopifySales(site.store);
    const { report } = await import("./status");
    await report("shopify-sales", true);
    await sql`INSERT INTO insights_report_cache (cache_key, data, fetched_at) VALUES (${key}, ${JSON.stringify(s)}::jsonb, now())
      ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
    return s;
  } catch (e) {
    if (needsOrderAccess(e)) return "access";
    // A failure the Inspector must see, never swallowed.
    const { report } = await import("./status");
    await report("shopify-sales", false, (e as Error).message);
    throw e;
  }
}
