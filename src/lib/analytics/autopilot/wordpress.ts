import { createHash } from "crypto";
import { ensureSchema, sql } from "../db";
import { tokenSecret } from "../oauth-client";
import { decrypt, encrypt } from "../secrets";
import type { ArticleSummary, StoreResource } from "./shopify";

/**
 * WordPress through the Insights Connector plugin (wordpress-plugin/). The
 * site owner installs it and clicks "Connect to Insights", which hands the
 * plugin's private key to the app once; every call then carries that key.
 * The plugin writes titles and descriptions into whichever SEO plugin the
 * site uses (Yoast, Rank Math, SEOPress, All in One SEO) or shows them
 * itself, appends content, and prints structured data in the page head.
 */

export interface WpAccess {
  /** The site's home address, ending with "/". */
  site: string;
  key: string;
  name?: string;
  seoPlugin?: string;
}

const storeKey = (accountId: string) => `wp:${accountId}`;

export async function readWp(accountId: string): Promise<WpAccess | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${storeKey(accountId)}`;
  const json = row?.value ? decrypt(row.value, await tokenSecret()) : null;
  return json ? (JSON.parse(json) as WpAccess) : null;
}

export async function saveWp(accountId: string, wp: WpAccess): Promise<void> {
  const value = encrypt(JSON.stringify(wp), await tokenSecret());
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${storeKey(accountId)}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export async function deleteWp(accountId: string): Promise<void> {
  await sql`DELETE FROM insights_settings WHERE key = ${storeKey(accountId)}`;
}

/** Thrown when a post changed after it was read; the change is skipped, never forced. */
export class WpChanged extends Error {}

/** Calls the plugin's API (pretty permalinks first, then the ?rest_route= form every site supports). */
export async function wpRequest<T>(wp: WpAccess, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const base = wp.site.replace(/\/?$/, "/");
  const [route, query] = path.split("?");
  const urls = [`${base}wp-json/insights/v1${path}`, `${base}?rest_route=/insights/v1${route}${query ? `&${query}` : ""}`];
  let last = "";
  for (const url of urls) {
    const res = await fetch(url, {
      method,
      headers: { "X-Insights-Key": wp.key, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }).catch((e) => {
      last = (e as Error).message;
      return null;
    });
    if (!res) continue;
    const text = await res.text();
    let data: { code?: string; message?: string } | null = null;
    try {
      data = JSON.parse(text);
    } catch {
      // An HTML page: this address form doesn't reach the API; try the next one.
      last = `the site answered ${res.status} without the plugin's API`;
      continue;
    }
    if (res.status === 409) throw new WpChanged(data?.message ?? "The post changed since it was read.");
    if (res.status === 401 || res.status === 403) throw new Error("WordPress didn't accept the connection. Click Connect to Insights again in Settings > Insights.");
    if (!res.ok) throw new Error(`WordPress: ${data?.message ?? res.status}`);
    return data as T;
  }
  throw new Error(`Couldn't reach the Insights Connector plugin on ${wp.site} (${last}). Is it installed and active?`);
}

interface WpItem {
  id: number;
  type: "article" | "page";
  url: string;
  title: string;
  content: string;
  seo_title: string | null;
  seo_description: string | null;
  schema: string | null;
  published: string | null;
  modified: string | null;
  author: string | null;
  image: string | null;
}

export async function wpHello(site: string, key: string): Promise<{ name: string; home: string; seo_plugin: string }> {
  return wpRequest(wp(site, key), "GET", "/hello");
}

const wp = (site: string, key: string): WpAccess => ({ site, key });

const toResource = (i: WpItem): StoreResource => ({
  type: i.type,
  id: String(i.id),
  title: i.title,
  url: i.url,
  body: i.content ?? "",
  metaTitle: i.seo_title,
  metaDescription: i.seo_description,
  imagesMissingAlt: [],
  article: { publishedAt: i.published, updatedAt: i.modified, author: i.author, image: i.image },
});

export async function wpResolve(w: WpAccess, url: string): Promise<StoreResource | null> {
  try {
    return toResource(await wpRequest<WpItem>(w, "GET", `/resolve?url=${encodeURIComponent(url)}`));
  } catch (e) {
    if (/not a post or page|No published/i.test((e as Error).message)) return null;
    throw e;
  }
}

/** Published posts with their content, for internal link sources. */
export async function wpArticles(w: WpAccess): Promise<ArticleSummary[]> {
  const items = await wpRequest<WpItem[]>(w, "GET", "/items?type=post&page=1");
  return items.map((i) => ({ id: String(i.id), title: i.title, body: i.content ?? "", url: new URL(i.url).pathname }));
}

export async function wpGetBody(w: WpAccess, id: string): Promise<string> {
  return (await wpRequest<WpItem>(w, "GET", `/item/${id}`)).content ?? "";
}

/** md5 of the content as read, so the plugin only writes if nobody changed it since. */
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

export async function wpSetBodyIfUnchanged(w: WpAccess, id: string, expected: string, next: string): Promise<void> {
  await wpRequest(w, "POST", `/content/${id}`, { expected: md5(expected), content: next });
}

export async function wpSetBody(w: WpAccess, id: string, next: string): Promise<void> {
  await wpSetBodyIfUnchanged(w, id, await wpGetBody(w, id), next);
}

export async function wpSetSeo(w: WpAccess, id: string, field: "title" | "description", value: string | null): Promise<void> {
  await wpRequest(w, "POST", `/seo/${id}`, { [field]: value });
}

export async function wpSetSchema(w: WpAccess, id: string, schema: string | null): Promise<void> {
  await wpRequest(w, "POST", `/schema/${id}`, { schema });
}

/** Google's site verification code and Analytics tag id, which the plugin prints on every page (plugin 1.1+). */
export async function wpSetGoogle(w: WpAccess, codes: { verification: string | null; measurement: string | null }): Promise<void> {
  await wpRequest(w, "POST", "/google", codes);
}

/** A new post written by the app (plugin 1.2+). */
export async function wpCreatePost(
  w: WpAccess,
  a: { title: string; html: string; slug: string; summary: string; seoTitle: string; seoDescription: string; publish: boolean }
): Promise<{ id: string; url: string }> {
  const item = await wpRequest<WpItem>(w, "POST", "/create", {
    title: a.title,
    content: a.html,
    slug: a.slug,
    summary: a.summary,
    seo_title: a.seoTitle,
    seo_description: a.seoDescription,
    publish: a.publish,
  });
  return { id: String(item.id), url: item.url };
}

export async function wpSetPublished(w: WpAccess, id: string, publish: boolean): Promise<void> {
  await wpRequest(w, "POST", `/status/${id}`, { publish });
}
