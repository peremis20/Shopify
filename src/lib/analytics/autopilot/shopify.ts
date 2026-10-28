import type { AutopilotSettings } from "./settings";

/**
 * Shopify Admin GraphQL client for the autopilot. Uses a Dev Dashboard app's
 * client credentials grant: Client ID + secret exchanged for a 24 hour token.
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
const tokens = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(s: AutopilotSettings): Promise<string> {
  if (!s.shopDomain || !s.shopifyClientId || !s.shopifyClientSecret) {
    throw new Error("Add your Shopify store, Client ID and Client secret in Autopilot settings.");
  }
  const hit = tokens.get(s.shopDomain);
  if (hit && hit.expiresAt > Date.now() + 5 * 60_000) return hit.token;

  const res = await fetch(`https://${s.shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: s.shopifyClientId,
      client_secret: s.shopifyClientSecret,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Shopify didn't accept the app credentials (${body.error_description ?? body.error ?? res.status}). ` +
        "Check the store address, Client ID and secret, and that the app is installed on the store."
    );
  }
  tokens.set(s.shopDomain, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 86_399) * 1000 });
  return body.access_token;
}

export async function shopifyGql<T>(s: AutopilotSettings, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${s.shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await accessToken(s) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    const msg = Array.isArray(body.errors) ? body.errors.map((e: { message: string }) => e.message).join("; ") : body.errors;
    throw new Error(`Shopify request failed: ${msg ?? res.status}`);
  }
  // Mutations report problems in userErrors rather than errors.
  for (const payload of Object.values(body.data ?? {}) as { userErrors?: { message: string }[] }[]) {
    if (payload?.userErrors?.length) throw new Error(`Shopify rejected the change: ${payload.userErrors.map((e) => e.message).join("; ")}`);
  }
  return body.data as T;
}

export async function shopName(s: AutopilotSettings): Promise<string> {
  const d = await shopifyGql<{ shop: { name: string } }>(s, "{ shop { name } }");
  return d.shop.name;
}

export type ResourceType = "article" | "product" | "page" | "collection";

export interface StoreResource {
  type: ResourceType;
  id: string;
  title: string;
  url: string;
  /** HTML body for articles and pages; product/collection descriptions are read only. */
  body: string;
  metaTitle: string | null;
  metaDescription: string | null;
  /** Product images that have no alt text yet. */
  imagesMissingAlt: { id: string; url: string }[];
}

const SEO_FIELDS = `
  titleTag: metafield(namespace: "global", key: "title_tag") { value }
  descTag: metafield(namespace: "global", key: "description_tag") { value }`;

/** Finds the store item behind a page address, or null for pages the autopilot can't edit. */
export async function resolveResource(s: AutopilotSettings, url: string): Promise<StoreResource | null> {
  const path = new URL(url).pathname.replace(/\/$/, "");
  const parts = path.split("/").filter(Boolean);
  const handle = parts.at(-1);
  if (!handle) return null;

  if (parts[0] === "blogs" && parts.length === 3) {
    const d = await shopifyGql<{ articles: { nodes: { id: string; title: string; body: string; titleTag: { value: string } | null; descTag: { value: string } | null }[] } }>(
      s,
      `query($q: String!) { articles(first: 1, query: $q) { nodes { id title body ${SEO_FIELDS} } } }`,
      { q: `handle:${handle}` }
    );
    const a = d.articles.nodes[0];
    return a && { type: "article", id: a.id, title: a.title, url, body: a.body ?? "", metaTitle: a.titleTag?.value ?? null, metaDescription: a.descTag?.value ?? null, imagesMissingAlt: [] };
  }
  if (parts[0] === "pages" && parts.length === 2) {
    const d = await shopifyGql<{ pages: { nodes: { id: string; title: string; body: string; titleTag: { value: string } | null; descTag: { value: string } | null }[] } }>(
      s,
      `query($q: String!) { pages(first: 1, query: $q) { nodes { id title body ${SEO_FIELDS} } } }`,
      { q: `handle:${handle}` }
    );
    const p = d.pages.nodes[0];
    return p && { type: "page", id: p.id, title: p.title, url, body: p.body ?? "", metaTitle: p.titleTag?.value ?? null, metaDescription: p.descTag?.value ?? null, imagesMissingAlt: [] };
  }
  if (parts[0] === "products" && parts.length === 2) {
    const d = await shopifyGql<{ products: { nodes: { id: string; title: string; descriptionHtml: string; titleTag: { value: string } | null; descTag: { value: string } | null; media: { nodes: { id?: string; alt?: string | null; image?: { url: string } }[] } }[] } }>(
      s,
      `query($q: String!) { products(first: 1, query: $q) { nodes { id title descriptionHtml ${SEO_FIELDS}
        media(first: 20) { nodes { ... on MediaImage { id alt image { url } } } } } } }`,
      { q: `handle:${handle}` }
    );
    const p = d.products.nodes[0];
    return p && {
      type: "product", id: p.id, title: p.title, url, body: p.descriptionHtml ?? "",
      metaTitle: p.titleTag?.value ?? null, metaDescription: p.descTag?.value ?? null,
      imagesMissingAlt: p.media.nodes.filter((m) => m.id && !m.alt?.trim() && m.image).map((m) => ({ id: m.id!, url: m.image!.url })),
    };
  }
  if (parts[0] === "collections" && parts.length === 2) {
    const d = await shopifyGql<{ collections: { nodes: { id: string; title: string; descriptionHtml: string; titleTag: { value: string } | null; descTag: { value: string } | null }[] } }>(
      s,
      `query($q: String!) { collections(first: 1, query: $q) { nodes { id title descriptionHtml ${SEO_FIELDS} } } }`,
      { q: `handle:${handle}` }
    );
    const c = d.collections.nodes[0];
    return c && { type: "collection", id: c.id, title: c.title, url, body: c.descriptionHtml ?? "", metaTitle: c.titleTag?.value ?? null, metaDescription: c.descTag?.value ?? null, imagesMissingAlt: [] };
  }
  return null;
}

export interface ArticleSummary {
  id: string;
  title: string;
  body: string;
  url: string;
}

/** Published blog posts, used as sources for internal links. */
export async function listArticles(s: AutopilotSettings): Promise<ArticleSummary[]> {
  const d = await shopifyGql<{ articles: { nodes: { id: string; handle: string; title: string; body: string; isPublished: boolean; blog: { handle: string } }[] } }>(
    s,
    `{ articles(first: 100, sortKey: PUBLISHED_AT, reverse: true) { nodes { id handle title body isPublished blog { handle } } } }`
  );
  return d.articles.nodes
    .filter((a) => a.isPublished)
    .map((a) => ({ id: a.id, title: a.title, body: a.body ?? "", url: `/blogs/${a.blog.handle}/${a.handle}` }));
}

export async function setSeoField(s: AutopilotSettings, ownerId: string, field: "title_tag" | "description_tag", value: string | null) {
  if (value === null || value === "") {
    await shopifyGql(s, `mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { userErrors { message } } }`, {
      m: [{ ownerId, namespace: "global", key: field }],
    });
    return;
  }
  await shopifyGql(s, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`, {
    m: [{ ownerId, namespace: "global", key: field, type: "single_line_text_field", value }],
  });
}

export async function getBody(s: AutopilotSettings, type: "article" | "page", id: string): Promise<string> {
  const field = type === "article" ? "article" : "page";
  const d = await shopifyGql<Record<string, { body: string } | null>>(s, `query($id: ID!) { ${field}(id: $id) { body } }`, { id });
  return d[field]?.body ?? "";
}

export async function setBody(s: AutopilotSettings, type: "article" | "page", id: string, body: string) {
  if (type === "article") {
    await shopifyGql(s, `mutation($id: ID!, $a: ArticleUpdateInput!) { articleUpdate(id: $id, article: $a) { userErrors { message } } }`, { id, a: { body } });
  } else {
    await shopifyGql(s, `mutation($id: ID!, $p: PageUpdateInput!) { pageUpdate(id: $id, page: $p) { userErrors { message } } }`, { id, p: { body } });
  }
}

export async function setImageAlt(s: AutopilotSettings, fileId: string, alt: string) {
  await shopifyGql(s, `mutation($f: [FileUpdateInput!]!) { fileUpdate(files: $f) { userErrors { message } } }`, {
    f: [{ id: fileId, alt }],
  });
}
