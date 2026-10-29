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
import { readConnection } from "./connections";
import type { ChangeField } from "./types";
import { wfArticles, wfFields, wfGetBody, wfResolve, wfSetBody, wfSetSeo, type WfAccess } from "./webflow";
import { wixResolve, wixSetTag, type WixAccess } from "./wix";

/**
 * Where the autopilot reads a site from, and how it writes to it.
 * - shopify: read and edit through the store's Admin API.
 * - wordpress: read and edit through the Insights Connector plugin.
 * - manual: any other website, read from its sitemap; changes become a fix
 *   list the owner pastes in (with where to paste it for their platform).
 */
export interface SiteAccess {
  mode: "shopify" | "wordpress" | "webflow" | "wix" | "manual";
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
  /** Whether this platform can make this kind of change to this item; when it can't, the change goes on the fix list. Everything when absent. */
  supports?(field: ChangeField, resourceId: string): Promise<boolean>;
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

/** The JSON inside a block of JSON-LD script tags: one object, or an array when there are several. */
export function jsonLdOf(block: string): string | null {
  const parts = [...block.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `[${parts.join(",")}]`;
}

/** Reads a page from the sitemap pages, for platforms that can't hand over this page (it then gets a fix list). */
async function crawledResource(accountId: string, url: string): Promise<StoreResource | null> {
  const p = await sitePage(accountId, url);
  if (!p || p.noindex) return null;
  return {
    type: isPostUrl(p.url) ? "article" : "page",
    id: `url:${p.url}`,
    title: p.h1 || p.title,
    url,
    body: p.mainHtml,
    metaTitle: p.title || null,
    metaDescription: p.metaDescription,
    imagesMissingAlt: [],
    article: { publishedAt: p.publishedAt, updatedAt: null, author: null, image: p.image },
  };
}

/** The page's text as visitors see it, for the writer, when the platform's API doesn't give it. */
async function withPageText(accountId: string, r: StoreResource | null): Promise<StoreResource | null> {
  if (!r || r.body) return r;
  const p = await sitePage(accountId, r.url).catch(() => null);
  return { ...r, body: p?.mainHtml ?? "" };
}

export function webflowSite(accountId: string, w: WfAccess, origin: string, brand: string): SiteAccess {
  return {
    mode: "webflow",
    store: null,
    writer: {
      setSeo: (id, field, value) => wfSetSeo(w, id, field, value),
      getBody: (_t, id) => wfGetBody(w, id),
      setBody: (_t, id, body) => wfSetBody(w, id, body),
      async setBodyIfUnchanged(_t, id, expected, next) {
        if ((await wfGetBody(w, id)) !== expected) throw new EditedMeanwhile();
        await wfSetBody(w, id, next);
      },
      async supports(field, id) {
        if (id.startsWith("url:")) return false;
        const can = await wfFields(w, id);
        if (field === "meta_title") return can.title;
        if (field === "meta_description") return can.description;
        if (field === "content" || field === "internal_link") return can.body;
        return false;
      },
    },
    resolve: async (url) => (await withPageText(accountId, await wfResolve(w, url).catch(() => null))) ?? crawledResource(accountId, url),
    articles: () => wfArticles(w, origin),
    index: () => crawledIndex(accountId),
    name: async () => w.name || brand,
  };
}

export function wixSite(accountId: string, w: WixAccess, brand: string): SiteAccess {
  return {
    mode: "wix",
    store: null,
    writer: {
      setSeo: (id, field, value) => wixSetTag(w, id, field, value),
      getBody: async () => "",
      setBody: async () => {
        throw new Error("Wix has no API for page text.");
      },
      setBodyIfUnchanged: async () => {
        throw new Error("Wix has no API for page text.");
      },
      setSchema: (_t, id, block) => wixSetTag(w, id, "schema", block ? jsonLdOf(block) : null),
      supports: async (field, id) => id.startsWith("post:") && (field === "meta_title" || field === "meta_description" || field === "schema"),
    },
    resolve: async (url) => (await withPageText(accountId, await wixResolve(w, url).catch(() => null))) ?? crawledResource(accountId, url),
    // Post text can't be edited on Wix, so internal links are suggested from the pages read from the sitemap.
    articles: () => manualSite(accountId, brand).articles(),
    index: () => crawledIndex(accountId),
    name: async () => brand,
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
  const wfAccess = await readConnection<WfAccess>("webflow", accountId).catch(() => null);
  if (wfAccess && profile.siteDomain) return webflowSite(accountId, wfAccess, `https://${profile.siteDomain}`, name);
  const wixAccess = await readConnection<WixAccess>("wix", accountId).catch(() => null);
  if (wixAccess) return wixSite(accountId, wixAccess, name);
  if (profile.siteDomain) return manualSite(accountId, name);
  return null;
}
