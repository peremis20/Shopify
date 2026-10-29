
import crypto from "crypto";
import {
  decryptShopTokens,
  encryptShopTokens,
  readAccountAutopilot,
  readPlatformSettings,
  saveAccountAutopilot,
} from "./settings";

/**
 * Shopify Admin GraphQL client for the autopilot. Each customer connects
 * their store to the platform's public Shopify app (OAuth authorization code
 * grant with expiring offline tokens); tokens refresh automatically.
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
export const SHOPIFY_SCOPES = "write_content,write_products,write_online_store_pages,write_files";
export const SHOPIFY_STATE_COOKIE = "insights_shopify_state";

/** Which store to act on: the customer's account. */
export interface StoreAccess {
  accountId: string;
  shopDomain: string;
}

interface ShopTokens {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

/** Accepts "peremis", "peremis.myshopify.com" or a full admin URL; returns the myshopify domain or null. */
export function normalizeShopDomain(input: string): string | null {
  const v = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const name = v.endsWith(".myshopify.com") ? v.slice(0, -".myshopify.com".length) : v.includes(".") ? "" : v;
  return /^[a-z0-9][a-z0-9-]*$/.test(name) ? `${name}.myshopify.com` : null;
}

async function platformApp() {
  const p = await readPlatformSettings();
  if (!p.shopifyClientId || !p.shopifyClientSecret) throw new Error("Shopify connections aren't available yet.");
  return { id: p.shopifyClientId, secret: p.shopifyClientSecret };
}

export async function authorizeUrl(shop: string, redirectUri: string, state: string): Promise<string> {
  const app = await platformApp();
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.search = new URLSearchParams({ client_id: app.id, scope: SHOPIFY_SCOPES, redirect_uri: redirectUri, state }).toString();
  return url.toString();
}

/** Checks the hmac Shopify adds to the OAuth callback. */
export async function verifyCallbackHmac(params: URLSearchParams): Promise<boolean> {
  const app = await platformApp();
  const hmac = params.get("hmac");
  if (!hmac) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = crypto.createHmac("sha256", app.secret).update(message).digest("hex");
  return digest.length === hmac.length && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

/** Checks the X-Shopify-Hmac-Sha256 header on a webhook body. */
export async function verifyWebhookHmac(rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const app = await platformApp();
  const digest = crypto.createHmac("sha256", app.secret).update(rawBody, "utf8").digest("base64");
  return digest.length === header.length && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(header));
}

async function tokenRequest(shop: string, params: Record<string, string>): Promise<ShopTokens> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Shopify didn't return access (${body.error_description ?? body.error ?? res.status}). Reconnect your store.`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

/** Finishes the OAuth flow and saves the store connection on the account. */
export async function completeInstall(accountId: string, shop: string, code: string): Promise<void> {
  const app = await platformApp();
  const tokens = await tokenRequest(shop, { client_id: app.id, client_secret: app.secret, code, expiring: "1" });
  await saveAccountAutopilot(accountId, { shopDomain: shop, shopTokenEnc: await encryptShopTokens(tokens) });
}

async function accessToken(access: StoreAccess): Promise<string> {
  const acct = await readAccountAutopilot(access.accountId);
  const tokens = acct.shopTokenEnc ? await decryptShopTokens<ShopTokens>(acct.shopTokenEnc) : null;
  if (!tokens) throw new Error("Connect your Shopify store first.");
  if (tokens.expiresAt > Date.now() + 5 * 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error("Your Shopify connection expired. Reconnect your store.");
  const app = await platformApp();
  const fresh = await tokenRequest(access.shopDomain, {
    client_id: app.id,
    client_secret: app.secret,
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });
  // Shopify rotates the refresh token on every use; keep the new one.
  await saveAccountAutopilot(access.accountId, { shopTokenEnc: await encryptShopTokens({ ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken }) });
  return fresh.accessToken;
}

export async function shopifyGql<T>(s: StoreAccess, query: string, variables: Record<string, unknown> = {}): Promise<T> {
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

export async function shopName(s: StoreAccess): Promise<string> {
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
  /** Blog posts only: what structured data needs. */
  article?: { publishedAt: string | null; updatedAt: string | null; author: string | null; image: string | null };
}

const SEO_FIELDS = `
  titleTag: metafield(namespace: "global", key: "title_tag") { value }
  descTag: metafield(namespace: "global", key: "description_tag") { value }`;

/** Finds the store item behind a page address, or null for pages the autopilot can't edit. */
export async function resolveResource(s: StoreAccess, url: string): Promise<StoreResource | null> {
  const path = new URL(url).pathname.replace(/\/$/, "");
  const parts = path.split("/").filter(Boolean);
  const handle = parts.at(-1);
  if (!handle) return null;

  if (parts[0] === "blogs" && parts.length === 3) {
    const d = await shopifyGql<{ articles: { nodes: {
      id: string; title: string; body: string; titleTag: { value: string } | null; descTag: { value: string } | null;
      publishedAt: string | null; updatedAt: string | null; author: { name: string } | null; image: { url: string } | null;
    }[] } }>(
      s,
      `query($q: String!) { articles(first: 1, query: $q) { nodes { id title body publishedAt updatedAt author { name } image { url } ${SEO_FIELDS} } } }`,
      { q: `handle:${handle}` }
    );
    const a = d.articles.nodes[0];
    return a && {
      type: "article", id: a.id, title: a.title, url, body: a.body ?? "", metaTitle: a.titleTag?.value ?? null, metaDescription: a.descTag?.value ?? null, imagesMissingAlt: [],
      article: { publishedAt: a.publishedAt, updatedAt: a.updatedAt, author: a.author?.name ?? null, image: a.image?.url ?? null },
    };
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
export async function listArticles(s: StoreAccess): Promise<ArticleSummary[]> {
  const d = await shopifyGql<{ articles: { nodes: { id: string; handle: string; title: string; body: string; isPublished: boolean; blog: { handle: string } }[] } }>(
    s,
    `{ articles(first: 100, sortKey: PUBLISHED_AT, reverse: true) { nodes { id handle title body isPublished blog { handle } } } }`
  );
  return d.articles.nodes
    .filter((a) => a.isPublished)
    .map((a) => ({ id: a.id, title: a.title, body: a.body ?? "", url: `/blogs/${a.blog.handle}/${a.handle}` }));
}

export async function setSeoField(s: StoreAccess, ownerId: string, field: "title_tag" | "description_tag", value: string | null) {
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

export async function getBody(s: StoreAccess, type: "article" | "page", id: string): Promise<string> {
  const field = type === "article" ? "article" : "page";
  const d = await shopifyGql<Record<string, { body: string } | null>>(s, `query($id: ID!) { ${field}(id: $id) { body } }`, { id });
  return d[field]?.body ?? "";
}

export async function setBody(s: StoreAccess, type: "article" | "page", id: string, body: string) {
  if (type === "article") {
    await shopifyGql(s, `mutation($id: ID!, $a: ArticleUpdateInput!) { articleUpdate(id: $id, article: $a) { userErrors { message } } }`, { id, a: { body } });
  } else {
    await shopifyGql(s, `mutation($id: ID!, $p: PageUpdateInput!) { pageUpdate(id: $id, page: $p) { userErrors { message } } }`, { id, p: { body } });
  }
}

export async function setImageAlt(s: StoreAccess, fileId: string, alt: string) {
  await shopifyGql(s, `mutation($f: [FileUpdateInput!]!) { fileUpdate(files: $f) { userErrors { message } } }`, {
    f: [{ id: fileId, alt }],
  });
}
