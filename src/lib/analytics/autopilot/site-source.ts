import { readProfile } from "../profile";
import { isPostUrl, sitePage, sitePages } from "../site-crawl";
import { plainText, siteIndex, type SiteItem } from "./guards";
import { readAccountAutopilot } from "./settings";
import {
  getBody,
  listArticles,
  resolveResource,
  setBody,
  setImageAlt,
  setSeoField,
  shopName,
  type ArticleSummary,
  type StoreAccess,
  type StoreResource,
} from "./shopify";
import {
  readWp,
  WpChanged,
  wpArticles,
  wpGetBody,
  wpResolve,
  wpSetBody,
  wpSetBodyIfUnchanged,
  wpSetSchema,
  wpSetSeo,
  type WpAccess,
} from "./wordpress";

/**
 * Where the autopilot reads a site from, and how it writes to it.
 * - shopify: read and edit through the store's Admin API.
 * - wordpress: read and edit through the Insights Connector plugin.
 * - manual: any other website, read from its sitemap; changes become a fix
 *   list the owner pastes in (with where to paste it for their platform).
 */
export interface SiteAccess {
  mode: "shopify" | "wordpress" | "manual";
  /** Set for Shopify only (link fixer). */
  store: StoreAccess | null;
  /** How changes are written; null means they go on the fix list. */
  writer: SiteWriter | null;
  resolve(url: string): Promise<StoreResource | null>;
  articles(): Promise<ArticleSummary[]>;
  index(): Promise<SiteItem[]>;
  name(): Promise<string>;
}

type BodyType = "article" | "page";

export interface SiteWriter {
  setSeo(resourceId: string, field: "title" | "description", value: string | null): Promise<void>;
  setAlt?(imageId: string, alt: string): Promise<void>;
  getBody(type: BodyType, id: string): Promise<string>;
  setBody(type: BodyType, id: string, body: string): Promise<void>;
  /** Writes only if the body is still `expected`; otherwise throws EditedMeanwhile. */
  setBodyIfUnchanged(type: BodyType, id: string, expected: string, next: string): Promise<void>;
  /** Structured data kept apart from the content (WordPress prints it in the head). Without it, it's appended to the body. */
  setSchema?(type: BodyType, id: string, block: string | null): Promise<void>;
}

/** Thrown when someone edited a page while the autopilot was writing; the change is skipped, not forced. */
export class EditedMeanwhile extends Error {
  constructor() {
    super("The page was edited while this change was being written, so it was left alone.");
  }
}

function shopifyWriter(store: StoreAccess): SiteWriter {
  return {
    setSeo: (id, field, value) => setSeoField(store, id, field === "title" ? "title_tag" : "description_tag", value),
    setAlt: (imageId, alt) => setImageAlt(store, imageId, alt),
    getBody: (type, id) => getBody(store, type, id),
    setBody: (type, id, body) => setBody(store, type, id, body),
    async setBodyIfUnchanged(type, id, expected, next) {
      if ((await getBody(store, type, id)) !== expected) throw new EditedMeanwhile();
      await setBody(store, type, id, next);
    },
  };
}

function wordpressWriter(wp: WpAccess): SiteWriter {
  return {
    setSeo: (id, field, value) => wpSetSeo(wp, id, field, value),
    getBody: (_type, id) => wpGetBody(wp, id),
    setBody: (_type, id, body) => wpSetBody(wp, id, body),
    async setBodyIfUnchanged(_type, id, expected, next) {
      try {
        await wpSetBodyIfUnchanged(wp, id, expected, next);
      } catch (e) {
        if (e instanceof WpChanged) throw new EditedMeanwhile();
        throw e;
      }
    },
    setSchema: (_type, id, block) => wpSetSchema(wp, id, block),
  };
}

export function shopifySite(store: StoreAccess, fallbackName: string): SiteAccess {
  return {
    mode: "shopify",
    store,
    writer: shopifyWriter(store),
    resolve: (url) => resolveResource(store, url),
    articles: () => listArticles(store),
    index: () => siteIndex(store),
    name: () => shopName(store).catch(() => fallbackName),
  };
}

/** Pages read from the sitemap, as the duplicate guards see them. */
async function crawledIndex(accountId: string): Promise<SiteItem[]> {
  return (await sitePages(accountId)).map((p) => ({
    path: new URL(p.url).pathname,
    kind: isPostUrl(p.url) ? ("article" as const) : ("page" as const),
    title: p.h1 || p.title,
    seoTitle: p.title,
    seoDescription: p.metaDescription,
    text: plainText(p.text),
  }));
}

export function wordpressSite(accountId: string, wp: WpAccess, brand: string): SiteAccess {
  return {
    mode: "wordpress",
    store: null,
    writer: wordpressWriter(wp),
    resolve: (url) => wpResolve(wp, url),
    articles: () => wpArticles(wp),
    index: () => crawledIndex(accountId),
    name: async () => wp.name || brand,
  };
}

export function manualSite(accountId: string, brand: string): SiteAccess {
  return {
    mode: "manual",
    store: null,
    writer: null,
    async resolve(url) {
      const p = await sitePage(accountId, url);
      if (!p || p.noindex) return null;
      return {
        type: isPostUrl(p.url) ? "article" : "page",
        id: p.url,
        title: p.h1 || p.title,
        url,
        body: p.mainHtml,
        metaTitle: p.title || null,
        metaDescription: p.metaDescription,
        imagesMissingAlt: [],
        article: { publishedAt: p.publishedAt, updatedAt: null, author: null, image: p.image },
      };
    },
    async articles() {
      return (await sitePages(accountId, true))
        .filter((p) => isPostUrl(p.url))
        .map((p) => ({ id: p.url, title: p.h1 || p.title, body: p.mainHtml, url: new URL(p.url).pathname }));
    },
    index: () => crawledIndex(accountId),
    name: async () => brand,
  };
}

/** The account's site: its Shopify store, its connected WordPress, or any website by address. Null when none is connected. */
export async function siteFor(accountId: string, brand?: string | null): Promise<SiteAccess | null> {
  const [acct, profile, wp] = await Promise.all([readAccountAutopilot(accountId), readProfile(accountId), readWp(accountId).catch(() => null)]);
  const name = brand ?? profile.brandName ?? profile.siteDomain?.split(".")[0] ?? "";
  if (acct.shopDomain && acct.shopTokenEnc) return shopifySite({ accountId, shopDomain: acct.shopDomain }, name);
  if (wp) return wordpressSite(accountId, wp, name);
  if (profile.siteDomain) return manualSite(accountId, name);
  return null;
}
