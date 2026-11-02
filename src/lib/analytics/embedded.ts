import crypto from "crypto";
import { isAdminEmail, upsertAccount, type Account } from "./accounts";
import { encryptShopTokens, readAccountAutopilot, readPlatformSettings, saveAccountAutopilot } from "./autopilot/settings";
import { ensureSchema, sql } from "./db";

/**
 * The app inside Shopify admin. Installing from Shopify is the whole signup:
 * Shopify loads the app in an iframe and App Bridge adds a session token
 * (a short JWT signed with the app's secret) to every request. From it we
 * know the store, find or create its account, and get the store's access
 * token with Shopify's token exchange, so there is no separate login and no
 * "connect your store" step. Cookies don't work inside the iframe, which is
 * why the token is checked on every request instead.
 */

interface SessionToken {
  iss: string;
  dest: string;
  aud: string;
  sub?: string;
  exp: number;
  nbf: number;
}

const b64json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** The store a valid session token is for (like "mystore.myshopify.com"), or null. */
export async function verifySessionToken(token: string): Promise<string | null> {
  const app = await readPlatformSettings();
  if (!app.shopifyClientId || !app.shopifyClientSecret) return null;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  const expected = crypto.createHmac("sha256", app.shopifyClientSecret).update(`${h}.${p}`).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let claims: SessionToken;
  try {
    if (b64json(h).alg !== "HS256") return null;
    claims = b64json(p);
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  // A few seconds of leeway for clocks that disagree.
  if (claims.aud !== app.shopifyClientId || claims.exp < now - 5 || claims.nbf > now + 5) return null;
  const shop = new URL(claims.dest).hostname;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}

const bearer = (req: Request) => req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;

/** Trades the session token for the store's offline access token (Shopify token exchange). */
async function exchangeToken(accountId: string, shop: string, idToken: string): Promise<void> {
  const app = await readPlatformSettings();
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: app.shopifyClientId,
      client_secret: app.shopifyClientSecret,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      expiring: "1",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Shopify didn't give access (${body.error_description ?? body.error ?? res.status}).`);
  await saveAccountAutopilot(accountId, {
    shopDomain: shop,
    shopTokenEnc: await encryptShopTokens({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    }),
  });
}

/** The account for a store: the one already connected to it, or a new one named after the store. */
async function findOrCreateAccount(shop: string): Promise<Account> {
  await ensureSchema();
  const [row] = await sql`
    SELECT a.id, a.email FROM insights_account_autopilot ap JOIN insights_accounts a ON a.id = ap.account_id
    WHERE ap.shop_domain = ${shop} ORDER BY a.id LIMIT 1`;
  if (row) return { id: row.id!, email: row.email!, admin: isAdminEmail(row.email!) };
  return upsertAccount(shop);
}

/**
 * The account behind an embedded request, connecting the store on first use.
 * Null when the request carries no valid session token.
 */
export async function embeddedAccount(req: Request): Promise<Account | null> {
  const token = bearer(req);
  if (!token) return null;
  const shop = await verifySessionToken(token);
  if (!shop) return null;
  const account = await findOrCreateAccount(shop);
  const acct = await readAccountAutopilot(account.id);
  if (acct.shopDomain !== shop || !acct.shopTokenEnc) await exchangeToken(account.id, shop, token);
  return account;
}

// ---------- linking Google from inside Shopify ----------

const linkKey = () => crypto.createHmac("sha256", process.env.SESSION_SECRET ?? "").update("google-link").digest();

/** How long a ticket can be opened after it is made (the app opens it at once), and how long Google consent may take after that. */
const LINK_OPEN_MS = 3 * 60_000;
export const LINK_FINISH_MS = 20 * 60_000;

export interface LinkTicket {
  accountId: string;
  returnTo: string;
  /** Made from a signed in browser (session cookie): the callback then needs that same session. */
  session: boolean;
  /** Single use: the callback records it once. */
  nonce: string;
}

/**
 * A short-lived signed ticket that lets a top-level Google sign in attach to this account.
 * session: it was made with the session cookie, so only that signed in browser can finish it.
 */
export function googleLinkTicket(accountId: string, returnTo: string, session = false): string {
  const n = crypto.randomBytes(12).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ a: accountId, r: returnTo, e: Date.now() + LINK_OPEN_MS, s: session ? 1 : 0, n })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", linkKey()).update(payload).digest("base64url")}`;
}

/** A valid ticket, or null. grace: extra time allowed after it can no longer be opened (for the Google callback). */
export function readLinkTicket(ticket: string | null, grace = 0): LinkTicket | null {
  const [payload, sig] = (ticket ?? "").split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", linkKey()).update(payload).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { a, r, e, s, n } = b64json(payload);
    if (!(typeof e === "number" && e + grace > Date.now()) || typeof a !== "string" || typeof n !== "string") return null;
    return { accountId: a, returnTo: typeof r === "string" ? r : "", session: s === 1, nonce: n };
  } catch {
    return null;
  }
}

/** Marks a ticket used. False when it was used before (a ticket attaches Google once). */
export async function useLinkTicket(t: LinkTicket): Promise<boolean> {
  await ensureSchema();
  await sql`DELETE FROM insights_settings WHERE key LIKE 'linkused:%' AND updated_at < now() - interval '1 day'`.catch(() => undefined);
  const rows = await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`linkused:${t.nonce}`}, ${t.accountId})
    ON CONFLICT (key) DO NOTHING RETURNING key`;
  return rows.length > 0;
}

/** Where to send someone back into the app inside Shopify admin. */
export async function adminAppUrl(shop: string): Promise<string> {
  const app = await readPlatformSettings();
  return `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/apps/${app.shopifyClientId}`;
}
