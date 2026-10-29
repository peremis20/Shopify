import { isPostUrl, sitePage, sitePages } from "../site-crawl";
import { plainText, siteIndex, type SiteItem } from "./guards";
import { listArticles, resolveResource, shopName, type ArticleSummary, type StoreAccess, type StoreResource } from "./shopify";

/**
 * Where the autopilot reads a site from, and whether it can write to it.
 * - shopify: read and edit through the store's Admin API.
 * - manual: any other website, read from its sitemap; changes become a fix
 *   list the owner pastes in (with where to paste it for their platform).
 */
export interface SiteAccess {
  mode: "shopify" | "manual";
  /** Set for Shopify only: what edits go through. */
  store: StoreAccess | null;
  resolve(url: string): Promise<StoreResource | null>;
  articles(): Promise<ArticleSummary[]>;
  index(): Promise<SiteItem[]>;
  name(): Promise<string>;
}

export function shopifySite(store: StoreAccess, fallbackName: string): SiteAccess {
  return {
    mode: "shopify",
    store,
    resolve: (url) => resolveResource(store, url),
    articles: () => listArticles(store),
    index: () => siteIndex(store),
    name: () => shopName(store).catch(() => fallbackName),
  };
}

export function manualSite(accountId: string, brand: string): SiteAccess {
  return {
    mode: "manual",
    store: null,
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
    async index() {
      return (await sitePages(accountId)).map((p) => ({
        path: new URL(p.url).pathname,
        kind: isPostUrl(p.url) ? ("article" as const) : ("page" as const),
        title: p.h1 || p.title,
        seoTitle: p.title,
        seoDescription: p.metaDescription,
        text: plainText(p.text),
      }));
    },
    name: async () => brand,
  };
}
