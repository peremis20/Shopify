import { bareDomain } from "../profile";
import type { StoreResource } from "./shopify";

/**
 * Webflow through its Data API with a site token the owner creates (Site
 * settings > Apps & integrations > API access, with Sites, Pages and CMS read
 * and write). What it can change:
 * - static pages: SEO title and description (live at the next publish; the
 *   app publishes only when the site has no other unpublished changes);
 * - CMS items (blog posts): SEO fields the collection has, and new sections
 *   in the rich text body, written straight to the live item.
 * Structured data and static page content go on the fix list: site tokens
 * can't reach custom code, and the Designer owns page layout.
 */

const API = "https://api.webflow.com/v2";

export interface WfAccess {
  token: string;
  siteId: string;
  name: string;
  /** Custom domain ids, for publishing. */
  domainIds: string[];
}

export async function wf<T>(token: string, method: "GET" | "PUT" | "PATCH" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Webflow didn't accept the token (${data?.message ?? res.status}). Create a new one with Sites, Pages and CMS read and write.`);
  }
  if (!res.ok) throw new Error(`Webflow: ${data?.message ?? res.status}`);
  return data as T;
}

interface Site {
  id: string;
  displayName: string;
  shortName: string;
  lastPublished?: string | null;
  lastUpdated?: string | null;
  customDomains?: { id: string; url: string }[];
}

/** Finds the site this token can reach that serves the domain. */
export async function connectWebflow(token: string, domain: string): Promise<WfAccess> {
  const { sites } = await wf<{ sites: Site[] }>(token, "GET", "/sites");
  if (!sites?.length) throw new Error("That token can't see any Webflow site.");
  const site =
    sites.find((s) => (s.customDomains ?? []).some((d) => bareDomain(d.url) === domain)) ??
    sites.find((s) => `${s.shortName}.webflow.io` === domain) ??
    (sites.length === 1 ? sites[0] : null);
  if (!site) throw new Error(`None of this token's Webflow sites uses ${domain}.`);
  return { token, siteId: site.id, name: site.displayName, domainIds: (site.customDomains ?? []).map((d) => d.id) };
}

interface Page {
  id: string;
  title: string;
  collectionId?: string | null;
  publishedPath?: string;
  draft?: boolean;
  archived?: boolean;
  seo?: { title?: string; description?: string };
}

async function pages(w: WfAccess): Promise<Page[]> {
  const out: Page[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const d = await wf<{ pages: Page[]; pagination?: { total: number } }>(w.token, "GET", `/sites/${w.siteId}/pages?limit=100&offset=${offset}`);
    out.push(...(d.pages ?? []));
    if (!d.pagination || out.length >= d.pagination.total || !d.pages?.length) break;
  }
  return out;
}

interface Field {
  slug: string;
  displayName: string;
  type: string;
}

interface Collection {
  id: string;
  displayName: string;
  slug: string;
  fields?: Field[];
}

interface Item {
  id: string;
  isDraft?: boolean;
  isArchived?: boolean;
  lastPublished?: string | null;
  fieldData: Record<string, unknown>;
}

/** Which fields of a collection hold the SEO title, meta description and body, by their names. */
export function fieldMap(fields: Field[]) {
  const find = (re: RegExp, types?: string[]) =>
    fields.find((f) => re.test(`${f.slug} ${f.displayName}`.toLowerCase()) && (!types || types.includes(f.type)))?.slug ?? null;
  return {
    title: find(/seo[\s_-]*title|meta[\s_-]*title|title[\s_-]*tag/, ["PlainText"]),
    description: find(/meta[\s_-]*desc|seo[\s_-]*desc|search[\s_-]*desc/, ["PlainText"]),
    body: find(/body|content|post|article/, ["RichText"]) ?? fields.find((f) => f.type === "RichText")?.slug ?? null,
  };
}

async function collection(w: WfAccess, id: string): Promise<Collection> {
  return wf<Collection>(w.token, "GET", `/collections/${id}`);
}

/** Resource ids: "page:<pageId>" for static pages, "item:<collectionId>:<itemId>" for CMS items. */
export async function wfResolve(w: WfAccess, url: string): Promise<StoreResource | null> {
  const path = new URL(url).pathname.replace(/\/$/, "") || "/";
  const all = await pages(w);
  const live = all.filter((p) => !p.draft && !p.archived);
  const stat = live.find((p) => !p.collectionId && ((p.publishedPath ?? "").replace(/\/$/, "") || "/") === path);
  if (stat) {
    return {
      type: "page",
      id: `page:${stat.id}`,
      title: stat.title,
      url,
      body: "",
      metaTitle: stat.seo?.title ?? null,
      metaDescription: stat.seo?.description ?? null,
      imagesMissingAlt: [],
    };
  }
  // A CMS item: the template page's path is the folder, the item's slug the last part.
  const slug = path.split("/").pop()!;
  const folder = path.slice(0, path.length - slug.length - 1);
  const template = live.find((p) => p.collectionId && (p.publishedPath ?? "").replace(/\/[^/]*$/, "") === folder) ?? null;
  const ids = template ? [template.collectionId!] : [...new Set(live.filter((p) => p.collectionId).map((p) => p.collectionId!))];
  for (const cid of ids) {
    const items = await wf<{ items: Item[] }>(w.token, "GET", `/collections/${cid}/items/live?limit=100&slug=${encodeURIComponent(slug)}`).catch(() => ({ items: [] }));
    const item = items.items.find((i) => i.fieldData.slug === slug);
    if (!item) continue;
    const map = fieldMap((await collection(w, cid)).fields ?? []);
    const str = (k: string | null) => (k && typeof item.fieldData[k] === "string" ? (item.fieldData[k] as string) : null);
    return {
      type: "article",
      id: `item:${cid}:${item.id}`,
      title: String(item.fieldData.name ?? slug),
      url,
      body: str(map.body) ?? "",
      metaTitle: str(map.title),
      metaDescription: str(map.description),
      imagesMissingAlt: [],
      article: { publishedAt: item.lastPublished ?? null, updatedAt: null, author: null, image: null },
    };
  }
  return null;
}

/** What can be written for a resource. */
export async function wfFields(w: WfAccess, id: string) {
  if (id.startsWith("page:")) return { title: true, description: true, body: false };
  const [, cid] = id.split(":");
  const map = fieldMap((await collection(w, cid)).fields ?? []);
  return { title: Boolean(map.title), description: Boolean(map.description), body: Boolean(map.body) };
}

/** The change is saved in Webflow but waits for the owner's next publish. */
export class SavedNotLive extends Error {
  constructor() {
    super("Saved in Webflow. It goes live the next time you publish the site (it had other unpublished changes, so the app didn't publish for you).");
    this.name = "SavedNotLive";
  }
}

/** Publishes the site, but only when nothing else is waiting to be published (the owner's own unfinished work stays unpublished). */
async function publishIfClean(w: WfAccess, before: Site): Promise<void> {
  const pending = before.lastUpdated && before.lastPublished && new Date(before.lastUpdated) > new Date(before.lastPublished);
  if (pending) throw new SavedNotLive();
  await wf(w.token, "POST", `/sites/${w.siteId}/publish`, { customDomains: w.domainIds, publishToWebflowSubdomain: !w.domainIds.length });
}

export async function wfSetSeo(w: WfAccess, id: string, field: "title" | "description", value: string | null): Promise<void> {
  if (id.startsWith("page:")) {
    const pageId = id.slice(5);
    const site = await wf<Site>(w.token, "GET", `/sites/${w.siteId}`);
    const page = await wf<Page>(w.token, "GET", `/pages/${pageId}`);
    await wf(w.token, "PUT", `/pages/${pageId}`, { seo: { ...page.seo, [field]: value ?? "" } });
    await publishIfClean(w, site);
    return;
  }
  const [, cid, iid] = id.split(":");
  const map = fieldMap((await collection(w, cid)).fields ?? []);
  const slug = map[field];
  if (!slug) throw new Error("This collection has no field for that.");
  await wf(w.token, "PATCH", `/collections/${cid}/items/${iid}/live`, { fieldData: { [slug]: value ?? "" } });
}

export async function wfGetBody(w: WfAccess, id: string): Promise<string> {
  const [kind, cid, iid] = id.split(":");
  if (kind !== "item") return "";
  const map = fieldMap((await collection(w, cid)).fields ?? []);
  const item = await wf<Item>(w.token, "GET", `/collections/${cid}/items/${iid}/live`);
  return map.body && typeof item.fieldData[map.body] === "string" ? (item.fieldData[map.body] as string) : "";
}

export async function wfSetBody(w: WfAccess, id: string, body: string): Promise<void> {
  const [kind, cid, iid] = id.split(":");
  if (kind !== "item") throw new Error("Static Webflow pages are edited in the Designer.");
  const map = fieldMap((await collection(w, cid)).fields ?? []);
  if (!map.body) throw new Error("This collection has no rich text body.");
  await wf(w.token, "PATCH", `/collections/${cid}/items/${iid}/live`, { fieldData: { [map.body]: body } });
}

/** Blog posts with their bodies, for internal link sources: items of the collection behind the site's template pages. */
export async function wfArticles(w: WfAccess, origin: string): Promise<{ id: string; title: string; body: string; url: string }[]> {
  const templates = (await pages(w)).filter((p) => p.collectionId && !p.draft && !p.archived);
  const out: { id: string; title: string; body: string; url: string }[] = [];
  for (const t of templates.slice(0, 3)) {
    const map = fieldMap((await collection(w, t.collectionId!)).fields ?? []);
    if (!map.body) continue;
    const { items } = await wf<{ items: Item[] }>(w.token, "GET", `/collections/${t.collectionId}/items/live?limit=100`).catch(() => ({ items: [] as Item[] }));
    const folder = (t.publishedPath ?? "").replace(/\/[^/]*$/, "");
    for (const i of items) {
      out.push({
        id: `item:${t.collectionId}:${i.id}`,
        title: String(i.fieldData.name ?? ""),
        body: typeof i.fieldData[map.body] === "string" ? (i.fieldData[map.body] as string) : "",
        url: new URL(`${folder}/${i.fieldData.slug}`, origin).pathname,
      });
    }
  }
  return out;
}
