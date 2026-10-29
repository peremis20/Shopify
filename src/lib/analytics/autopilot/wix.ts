import type { StoreResource } from "./shopify";

/**
 * Wix through its REST API with an API key the owner creates (Wix account >
 * API Keys, with Wix Blog permissions) plus the site's id. Wix lets apps edit
 * blog posts' SEO title, meta description and structured data (as SEO tags on
 * the post, published right away). Static Wix pages and post text have no
 * edit API, so those improvements go on the fix list.
 */

const API = "https://www.wixapis.com";

export interface WixAccess {
  apiKey: string;
  siteId: string;
}

export async function wix<T>(w: WixAccess, method: "GET" | "PATCH" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: w.apiKey, "wix-site-id": w.siteId, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Wix didn't accept the API key for this site (${data?.message ?? res.status}). Check the key has Wix Blog permissions and the site id is right.`);
  }
  if (!res.ok) throw new Error(`Wix: ${data?.message ?? res.status}`);
  return data as T;
}

/** An SEO tag on a Wix post: the title, a meta tag, or a script (structured data). */
export interface WixTag {
  type: string;
  children?: string;
  props?: Record<string, string>;
  custom?: boolean;
  disabled?: boolean;
}

interface Post {
  id: string;
  title: string;
  url?: { base?: string; path?: string };
  firstPublishedDate?: string;
  lastPublishedDate?: string;
  seoData?: { tags?: WixTag[] };
}

/** Checks the key reaches the site's blog. */
export async function connectWix(w: WixAccess): Promise<void> {
  await wix(w, "GET", "/blog/v3/posts?paging.limit=1");
}

async function posts(w: WixAccess): Promise<Post[]> {
  const out: Post[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const d = await wix<{ posts: Post[] }>(w, "GET", `/blog/v3/posts?paging.limit=100&paging.offset=${offset}&fieldsets=URL&fieldsets=SEO`);
    out.push(...(d.posts ?? []));
    if ((d.posts ?? []).length < 100) break;
  }
  return out;
}

export const tagTitle = (tags: WixTag[] = []) => tags.find((t) => t.type === "title" && !t.disabled)?.children ?? null;
export const tagDescription = (tags: WixTag[] = []) =>
  tags.find((t) => t.type === "meta" && t.props?.name === "description" && !t.disabled)?.props?.content ?? null;

/** Puts one tag in place of its kind (null removes it), keeping every other tag. */
export function withTag(tags: WixTag[] = [], kind: "title" | "description" | "schema", value: string | null): WixTag[] {
  const same = (t: WixTag) =>
    kind === "title" ? t.type === "title" : kind === "description" ? t.type === "meta" && t.props?.name === "description" : t.type === "script" && t.props?.type === "application/ld+json" && t.custom;
  const rest = tags.filter((t) => !same(t));
  if (value === null) return rest;
  const tag: WixTag =
    kind === "title"
      ? { type: "title", children: value, custom: true }
      : kind === "description"
        ? { type: "meta", props: { name: "description", content: value }, custom: true }
        : { type: "script", props: { type: "application/ld+json" }, children: value, custom: true };
  return [...rest, tag];
}

/** Blog posts are "post:<id>"; anything else isn't editable on Wix. */
export async function wixResolve(w: WixAccess, url: string): Promise<StoreResource | null> {
  const path = new URL(url).pathname.replace(/\/$/, "");
  const post = (await posts(w)).find((p) => (p.url?.path ?? "").replace(/\/$/, "") === path);
  if (!post) return null;
  return {
    type: "article",
    id: `post:${post.id}`,
    title: post.title,
    url,
    body: "",
    metaTitle: tagTitle(post.seoData?.tags),
    metaDescription: tagDescription(post.seoData?.tags),
    imagesMissingAlt: [],
    article: { publishedAt: post.firstPublishedDate ?? null, updatedAt: post.lastPublishedDate ?? null, author: null, image: null },
  };
}

/** Edits a post's SEO tags on its draft and publishes it, which updates the live post. */
export async function wixSetTag(w: WixAccess, id: string, kind: "title" | "description" | "schema", value: string | null): Promise<void> {
  const postId = id.replace(/^post:/, "");
  const { draftPost } = await wix<{ draftPost: { id: string; seoData?: { tags?: WixTag[] } } }>(w, "GET", `/blog/v3/draft-posts/${postId}?fieldsets=SEO`);
  const seoData = { ...(draftPost.seoData ?? {}), tags: withTag(draftPost.seoData?.tags, kind, value) };
  await wix(w, "PATCH", `/blog/v3/draft-posts/${postId}`, { draftPost: { id: postId, seoData } });
  await wix(w, "POST", `/blog/v3/draft-posts/${postId}/publish`, {});
}
