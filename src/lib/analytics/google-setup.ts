import { readAccountAutopilot, readPlatformSettings } from "./autopilot/settings";
import { shopifyGql, type StoreAccess } from "./autopilot/shopify";
import { getConnection, saveConnection, type Connection } from "./connection";
import { ensureSchema, sql } from "./db";
import { GoogleApiError, googleRequest, hasScope, SETUP_SCOPES, type GoogleAuth } from "./google-auth";
import { bareDomain, saveProfile } from "./profile";

/**
 * "Set it up for me", for stores with no Search Console or Analytics yet.
 *
 * Search Console: Google gives a verification code, the app stores it on the
 * shop (app data the "Google setup" theme embed prints in the page head),
 * then asks Google to verify, adds the site and submits its sitemap.
 * Analytics: creates a GA4 property and web stream in the customer's own
 * Analytics account, and the same embed adds its tag.
 *
 * Each call does what it can and says what's needed next: more Google
 * permission, turning on the embed (one click in the theme editor), or a free
 * Analytics account, which only Google's own page can create.
 */

export type SetupState =
  | { status: "needs_permission" }
  | { status: "needs_embed"; embedUrl: string }
  | { status: "needs_ga_account" }
  | { status: "done"; notes: string[] };

const key = (accountId: string) => `gsetup:${accountId}`;

interface Saved {
  siteUrl?: string;
  verification?: string;
  measurementId?: string;
  propertyId?: string;
}

async function readSaved(accountId: string): Promise<Saved> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key(accountId)}`;
  return row?.value ? (JSON.parse(row.value) as Saved) : {};
}

async function writeSaved(accountId: string, s: Saved) {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${key(accountId)}, ${JSON.stringify(s)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

interface ShopInfo {
  shop: { name: string; ianaTimezone: string; currencyCode: string; primaryDomain: { host: string; sslEnabled: boolean } };
  currentAppInstallation: { id: string };
}

/** App data on the shop that the theme embed reads (namespace "insights"). */
async function setAppData(store: StoreAccess, ownerId: string, values: Record<string, string>) {
  await shopifyGql(store, `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`, {
    m: Object.entries(values).map(([k, value]) => ({ ownerId, namespace: "insights", key: k, type: "single_line_text_field", value })),
  });
}

/** Whether the live home page already shows a tag (the embed is on and the page has refreshed). */
async function pageShows(url: string, needle: string): Promise<boolean> {
  const html = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SiteSetup/1.0)" }, redirect: "follow" })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  return html.includes(needle);
}

/** The theme editor with the app embed switched on, ready to save. */
async function embedUrl(store: StoreAccess): Promise<string> {
  const app = await readPlatformSettings();
  return `https://${store.shopDomain}/admin/themes/current/editor?context=apps&activateAppId=${app.shopifyClientId}/google-setup`;
}

/** Creates a GA4 property and web stream for the site in the customer's Analytics account (one named after the store, or the first). */
async function createAnalytics(auth: GoogleAuth, info: ShopInfo["shop"], siteUrl: string): Promise<{ propertyId: string; measurementId: string } | null> {
  const accounts = await googleRequest<{ accounts?: { name: string; displayName: string }[] }>(
    auth,
    "https://analyticsadmin.googleapis.com/v1beta/accounts?pageSize=50"
  );
  const domain = bareDomain(siteUrl) ?? info.primaryDomain.host;
  const root = domain.split(".")[0];
  const list = accounts.accounts ?? [];
  const parent = (list.find((a) => a.displayName.toLowerCase().includes(root) || a.displayName.toLowerCase().includes(info.name.toLowerCase())) ?? list[0])?.name;
  if (!parent) return null;
  const property = await googleRequest<{ name: string }>(auth, "https://analyticsadmin.googleapis.com/v1beta/properties", {
    parent,
    displayName: domain,
    timeZone: info.ianaTimezone,
    currencyCode: info.currencyCode,
    industryCategory: "HEALTHCARE",
  });
  const stream = await googleRequest<{ webStreamData?: { measurementId?: string } }>(
    auth,
    `https://analyticsadmin.googleapis.com/v1beta/${property.name}/dataStreams`,
    { type: "WEB_DATA_STREAM", displayName: domain, webStreamData: { defaultUri: siteUrl.replace(/\/$/, "") } }
  );
  const measurementId = stream.webStreamData?.measurementId;
  if (!measurementId) throw new Error("Google created the Analytics property but didn't return its tag id.");
  return { propertyId: property.name.replace(/^properties\//, ""), measurementId };
}

const permissionError = (e: unknown) => e instanceof GoogleApiError && (e.status === 403 || e.status === 401) && /scope|permission/i.test(e.message);

export async function setupGoogle(accountId: string): Promise<SetupState> {
  const [conn, acct] = await Promise.all([getConnection(accountId), readAccountAutopilot(accountId)]);
  if (!conn) throw new Error("Connect Google first.");
  if (!acct.shopDomain || !acct.shopTokenEnc) throw new Error("Connect your Shopify store first.");
  const auth: GoogleAuth = { kind: "oauth", refreshToken: conn.refreshToken };
  for (const scope of SETUP_SCOPES) if (!(await hasScope(auth, scope))) return { status: "needs_permission" };

  const store = { accountId, shopDomain: acct.shopDomain };
  const info = await shopifyGql<ShopInfo>(
    store,
    "{ shop { name ianaTimezone currencyCode primaryDomain { host sslEnabled } } currentAppInstallation { id } }"
  );
  const saved = await readSaved(accountId);
  const siteUrl = saved.siteUrl ?? `${info.shop.primaryDomain.sslEnabled ? "https" : "http"}://${info.shop.primaryDomain.host}/`;
  const notes: string[] = [];
  const next: Connection = { ...conn };

  try {
    // 1. Codes and ids, stored on the shop for the embed to print.
    if (!conn.gscSiteUrl && !saved.verification) {
      const t = await googleRequest<{ token: string }>(auth, "https://www.googleapis.com/siteVerification/v1/token", {
        site: { type: "SITE", identifier: siteUrl },
        verificationMethod: "META",
      });
      saved.verification = t.token.match(/content="([^"]+)"/)?.[1] ?? t.token;
    }
    if (!conn.gaPropertyId && !saved.measurementId) {
      // No property for this site is visible (it would have been matched), so the store gets its own.
      const created = await createAnalytics(auth, info.shop, siteUrl);
      if (!created) return { status: "needs_ga_account" };
      Object.assign(saved, created);
      notes.push("Created a Google Analytics property for your store.");
    }
    await writeSaved(accountId, { ...saved, siteUrl });
    const data: Record<string, string> = {};
    if (saved.verification && !conn.gscSiteUrl) data.gsc_verification = saved.verification;
    if (saved.measurementId) data.ga_measurement_id = saved.measurementId;
    if (Object.keys(data).length) await setAppData(store, info.currentAppInstallation.id, data);
    if (saved.propertyId && !conn.gaPropertyId) next.gaPropertyId = saved.propertyId;

    // 2. The embed has to be on before Google can see the tag.
    const needle = saved.verification && !conn.gscSiteUrl ? saved.verification : saved.measurementId;
    if (needle && !(await pageShows(siteUrl, needle))) {
      if (next.gaPropertyId !== conn.gaPropertyId) await saveConnection(accountId, next);
      return { status: "needs_embed", embedUrl: await embedUrl(store) };
    }

    // 3. Verify, add to Search Console, submit the sitemap.
    if (!conn.gscSiteUrl && saved.verification) {
      await googleRequest(auth, "https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=META", {
        site: { type: "SITE", identifier: siteUrl },
      });
      await googleRequest(auth, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`, undefined, {}, "PUT");
      await googleRequest(
        auth,
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(`${siteUrl}sitemap.xml`)}`,
        undefined,
        {},
        "PUT"
      ).catch(() => notes.push("Couldn't submit the sitemap yet; Google will still find it."));
      next.gscSiteUrl = siteUrl;
      notes.push(`Verified ${siteUrl} in Search Console and submitted its sitemap. Search data starts showing in 2 to 3 days.`);
    }
  } catch (e) {
    if (permissionError(e)) return { status: "needs_permission" };
    throw e;
  }

  await saveConnection(accountId, next);
  const domain = bareDomain(siteUrl);
  if (domain && !domain.endsWith(".myshopify.com")) await saveProfile(accountId, { siteDomain: domain });
  return { status: "done", notes: notes.length ? notes : ["Search Console and Analytics are already set up."] };
}
