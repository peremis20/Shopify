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
  /** Free orders (samples) among `orders`, over the whole period. */
  free?: number;
  /** Orders placed in the online store (not POS or drafts) that are paid, over the whole period. */
  paidOnline?: number;
  /** More orders than were read (over 1,000 in the period): the totals are a lower bound. */
  capped?: boolean;
  /** Orders of the last 7 days and the 7 before, from Shopify; free orders (samples) counted apart. */
  week?: { orders: number; revenue: number; free: number };
  weekBefore?: { orders: number; revenue: number; free: number };
  /** Sales over the same days Google Analytics reports (7 whole days to yesterday, shop time), to compare the two. */
  analyticsWeekRevenue?: number;
  /** The last day `analyticsWeekRevenue` covers, and the shop's time zone it was counted in. */
  analyticsWeekTo?: string;
  timezone?: string | null;
  /** The pages Google search buyers landed on, most orders first. */
  pages: { path: string; orders: number; revenue: number }[];
  /** Where every order came from (Shopify's customer journey, else the sales channel), most orders first. */
  sources?: { name: string; orders: number; revenue: number }[];
  /** Orders whose visit came from the Newsletter's own emails (utm_source=newsletter), by their utm_campaign. */
  newsletter?: { campaign: string; orders: number; revenue: number }[];
}

interface Visit {
  source: string | null;
  referrerUrl: string | null;
  landingPage: string | null;
  utmParameters: { medium: string | null; source?: string | null; campaign?: string | null } | null;
}

/** The host of a URL or bare domain, without "www."; null when it isn't one. */
const hostOf = (x: string | null | undefined): string | null => {
  if (!x || !/[.]/.test(x) || /\s/.test(x.trim())) return null;
  try {
    return new URL(/^https?:/i.test(x) ? x : `https://${x}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};
const isPaid = (v: Visit) => /cpc|ppc|paid/i.test(v.utmParameters?.medium ?? "");
/** Google itself (search or ads), never another Google product such as Gemini or Gmail. */
const GOOGLE_HOST = /^google\.(com|[a-z]{2,3}(\.[a-z]{2})?)$/;
const isGoogle = (v: Visit) => {
  const src = (v.source ?? "").trim();
  return /^google( shopping)?$/i.test(src) || /googlequicksearchbox/i.test(src) || /googlequicksearchbox/i.test(v.referrerUrl ?? "") ||
    GOOGLE_HOST.test(hostOf(v.referrerUrl) ?? "") || GOOGLE_HOST.test(hostOf(src) ?? "");
};
const GOOGLE_ADS_SOURCE = /^(google|google[ _]?ads|adwords)$/i;

const fromGoogleSearch = (v: Visit | null) => Boolean(v && isGoogle(v) && !isPaid(v));

/** A visit from a DashPatrol newsletter email: its links carry utm_source=newsletter (newsletter.ts withUtm). */
export const fromNewsletter = (v: Visit | null) => /^newsletter$/i.test((v?.utmParameters?.source ?? "").trim());
/** The newsletter visit that led to an order (the last one first), or null. */
export const newsletterVisit = (j: { firstVisit: Visit | null; lastVisit: Visit | null } | null) =>
  fromNewsletter(j?.lastVisit ?? null) ? j!.lastVisit : fromNewsletter(j?.firstVisit ?? null) ? j!.firstVisit : null;

/** Known places, matched on the visit's source name and the referring host only, never a page path. */
const KNOWN: [RegExp, string][] = [
  [/(^|\.)tiktok\.com$|^tiktok$/i, "TikTok"],
  [/(^|\.)(chatgpt|openai)\.com$|^chatgpt$/i, "ChatGPT"],
  [/(^|\.)perplexity\.ai$|^perplexity$/i, "Perplexity"],
  [/^gemini\.google\.com$|^bard\.google\.com$|^gemini$/i, "Gemini"],
  [/^mail\.google\.com$|^gmail$/i, "Gmail"],
  [/(^|\.)copilot\.microsoft\.com$|^copilot$/i, "Copilot"],
  [/(^|\.)instagram\.com$|^instagram$/i, "Instagram"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$|^facebook$/i, "Facebook"],
  [/(^|\.)pinterest\.[a-z.]+$|^pinterest$/i, "Pinterest"],
  [/(^|\.)(youtube\.com|youtu\.be)$|^youtube$/i, "YouTube"],
  [/(^|\.)bing\.com$|^bing$/i, "Bing"],
  [/(^|\.)klaviyo\.com$|^(klaviyo|shopify_email|email|newsletter)$/i, "Email"],
];
const CHANNELS: Record<string, string> = { tiktok: "TikTok Shop", pos: "In person", shopify_draft_order: "Draft orders", web: "Direct or unknown", iphone: "Shop app", android: "Shop app" };
/** Plain text for a name we don't know: no dashes, no underscores. */
const clean = (x: string) => x.replace(/[_]+/g, " ").replace(/\s*[-–—]+\s*/g, " ").replace(/\s+/g, " ").trim();

/** One plain name for where an order came from. Google search matches how `fromGoogle` is counted. Pure. */
export function orderSource(sourceName: string | null, j: { firstVisit: Visit | null; lastVisit: Visit | null } | null): string {
  if (fromGoogleSearch(j?.lastVisit ?? null) || fromGoogleSearch(j?.firstVisit ?? null)) return "Google search";
  // After Google search, so the sources list still matches how `fromGoogle` is counted.
  if (newsletterVisit(j)) return "Newsletter";
  const v = j?.lastVisit ?? j?.firstVisit ?? null;
  if (v) {
    if (isGoogle(v) || (isPaid(v) && GOOGLE_ADS_SOURCE.test((v.source ?? "").trim()))) return "Google ads";
    const keys = [(v.source ?? "").trim(), hostOf(v.source), hostOf(v.referrerUrl)].filter((k): k is string => Boolean(k));
    for (const [re, name] of KNOWN) if (keys.some((k) => re.test(k))) return name;
    // Shopify names the source from the referrer, so a direct visit's referrer is the store itself: not a source.
    if (!v.source || /^(direct|unknown|\(direct\)|\(none\))$/i.test(v.source.trim())) return "Direct or unknown";
    if (/^other$/i.test(v.source.trim())) return "Other";
    return hostOf(v.source) ?? (clean(v.source) || "Direct or unknown");
  }
  const ch = (sourceName ?? "").trim().toLowerCase();
  if (!ch) return "Direct or unknown";
  if (/^\d+$/.test(ch)) return "Other app";
  return CHANNELS[ch] ?? clean(ch).replace(/^./, (c) => c.toUpperCase());
}

/** A day as YYYY-MM-DD in the given time zone (UTC when unknown or invalid). */
function localDay(ms: number, tz: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * True when an order falls in the same days Google Analytics calls the last 7: seven whole days ending yesterday, in
 * the shop's time zone. So the two sales numbers can be compared like with like. Pure.
 */
/** The last day of the Analytics week (yesterday in the shop's time zone), so a cached number knows which days it covers. */
export function analyticsWeekEnd(now: number, tz: string | null): string {
  const today = localDay(now, tz);
  return new Date(Date.parse(`${today}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
}

export function inAnalyticsWeek(createdAt: string, now: number, tz: string | null): boolean {
  const day = localDay(Date.parse(createdAt), tz);
  const today = localDay(now, tz);
  const first = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10);
  return day >= first && day < today;
}

/** Orders of the last `days` days (up to 250), with the Google search share and its landing pages. */
export async function shopifySales(store: StoreAccess, days = 28): Promise<ShopifySales> {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const out: ShopifySales = { days, orders: 0, revenue: 0, free: 0, paidOnline: 0, currency: null, fromGoogle: 0, fromGoogleRevenue: 0, analyticsWeekRevenue: 0, pages: [], week: { orders: 0, revenue: 0, free: 0 }, weekBefore: { orders: 0, revenue: 0, free: 0 } };
  const now = Date.now();
  const pages = new Map<string, { orders: number; revenue: number }>();
  const sources = new Map<string, { orders: number; revenue: number }>();
  const letters = new Map<string, { orders: number; revenue: number }>();
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const d: {
      shop?: { ianaTimezone: string | null } | null;
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          test: boolean;
          createdAt: string;
          sourceName: string | null;
          cancelledAt: string | null;
          displayFinancialStatus: string | null;
          currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          totalPriceSet: { shopMoney: { amount: string } };
          customerJourneySummary: { firstVisit: Visit | null; lastVisit: Visit | null } | null;
        }[];
      };
    } = await shopifyGql(
      store,
      `query($q: String!, $after: String) { shop { ianaTimezone } orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) { pageInfo { hasNextPage endCursor } nodes {
        test createdAt sourceName cancelledAt displayFinancialStatus currentTotalPriceSet { shopMoney { amount currencyCode } } totalPriceSet { shopMoney { amount } }
        customerJourneySummary {
          firstVisit { source referrerUrl landingPage utmParameters { medium source campaign } }
          lastVisit { source referrerUrl landingPage utmParameters { medium source campaign } }
        } } } }`,
      { q: `created_at:>=${since}`, after },
    );
    if (out.timezone === undefined) out.timezone = d.shop?.ianaTimezone ?? null;
    for (const o of d.orders.nodes) {
      if (o.test || o.cancelledAt || o.displayFinancialStatus === "REFUNDED") continue;
      // After refunds and edits: what the store really kept.
      const amount = Number(o.currentTotalPriceSet.shopMoney.amount) || 0;
      out.orders++;
      out.revenue += amount;
      out.currency ??= o.currentTotalPriceSet.shopMoney.currencyCode;
      if ((Number(o.totalPriceSet.shopMoney.amount) || 0) === 0) out.free = (out.free ?? 0) + 1;
      else if (o.sourceName === "web" && /^(?:PAID|PARTIALLY_PAID|PARTIALLY_REFUNDED)$/.test(o.displayFinancialStatus ?? ""))
        out.paidOnline = (out.paidOnline ?? 0) + 1;
      if (inAnalyticsWeek(o.createdAt, now, out.timezone)) out.analyticsWeekRevenue = (out.analyticsWeekRevenue ?? 0) + amount;
      const age = now - Date.parse(o.createdAt);
      const bucket = age < 7 * 864e5 ? out.week : age < 14 * 864e5 ? out.weekBefore : null;
      if (bucket) {
        bucket.orders++;
        bucket.revenue += amount;
        // Free from the start (a sample), not an order whose money was given back.
        if ((Number(o.totalPriceSet.shopMoney.amount) || 0) === 0) bucket.free++;
      }
      const j = o.customerJourneySummary;
      const srcName = orderSource(o.sourceName, j);
      const src = sources.get(srcName) ?? { orders: 0, revenue: 0 };
      src.orders++;
      src.revenue += amount;
      sources.set(srcName, src);
      if (srcName === "Newsletter") {
        const slug = (newsletterVisit(j)?.utmParameters?.campaign ?? "").trim().slice(0, 80);
        const l = letters.get(slug) ?? { orders: 0, revenue: 0 };
        l.orders++;
        l.revenue += amount;
        letters.set(slug, l);
      }
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
  out.analyticsWeekTo = analyticsWeekEnd(now, out.timezone ?? null);
  out.newsletter = [...letters.entries()].map(([campaign, v]) => ({ campaign, ...v }));
  out.pages = [...pages.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.orders - a.orders || b.revenue - a.revenue).slice(0, 10);
  // The top 8 by name, the rest as one "Other" row, so the list stays short and still adds up to every order.
  const all = [...sources.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.orders - a.orders || b.revenue - a.revenue);
  // An "Other" row of its own joins the folded rest, so there is never a second one.
  const top = all.filter((x) => x.name !== "Other").slice(0, 8);
  const rest = all.filter((x) => !top.includes(x));
  out.sources = rest.length
    ? [...top, { name: "Other", orders: rest.reduce((n, x) => n + x.orders, 0), revenue: rest.reduce((n, x) => n + x.revenue, 0) }]
    : all;
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
  if (hit?.data) {
    const cached = (typeof hit.data === "string" ? JSON.parse(hit.data) : hit.data) as ShopifySales;
    // A row from before orders were grouped by source is read again, so the owner sees the new list now.
    // A row counted before the shop's midnight covers other days than Analytics now does, so it is read again.
    if (cached.sources !== undefined && cached.newsletter !== undefined && cached.analyticsWeekTo === analyticsWeekEnd(Date.now(), cached.timezone ?? null)) return cached;
  }
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
