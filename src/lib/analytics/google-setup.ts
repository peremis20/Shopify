import { readAccountAutopilot, readPlatformSettings } from "./autopilot/settings";
import { shopifyGql, type StoreAccess } from "./autopilot/shopify";
import { getConnection, saveConnection, type Connection } from "./connection";
import { ensureSchema, sql } from "./db";
import { GoogleApiError, googleRequest, hasScope, SETUP_SCOPES, type GoogleAuth } from "./google-auth";
import { checkSnippet, snippetInstalled, snippetKey, snippetTag as snippetTagFor } from "./autopilot/snippet";
import { readWp, wpSetGoogle } from "./autopilot/wordpress";
import { bareDomain, readProfile, saveProfile } from "./profile";

/**
 * "Set it up for me", for sites with no Search Console or Analytics yet, so
 * nobody has to face Google's own setup screens.
 *
 * Search Console: Google gives a verification code, the site shows it, then
 * the app asks Google to verify, adds the site and submits its sitemap.
 * Analytics: creates a GA4 property and web stream in the customer's own
 * Analytics account, and the site loads its tag.
 *
 * How the site shows them depends on what it's connected with:
 * - Shopify: app data the "Google setup" theme embed prints (one switch).
 * - WordPress: the connector plugin prints them (nothing to do).
 * - the snippet: loads the Analytics tag; the verification line is pasted
 *   once next to the snippet.
 * - anything else: the platform's own "Google verification" box, with the
 *   code ready to copy and where the box is.
 *
 * Each call does what it can and says what's needed next.
 */

export type SetupState =
  | { status: "needs_permission" }
  | { status: "needs_embed"; embedUrl: string }
  /** Codes for the owner to paste into their platform (verification is the full meta tag). */
  | {
      status: "needs_paste";
      platform: string | null;
      verificationTag: string | null;
      verificationCode: string | null;
      measurementId: string | null;
      gtag: string | null;
      snippet: boolean;
      /** When the snippet isn't on the site yet: pasted together with the verification line, it also loads Analytics. One paste for everything. */
      snippetTag: string | null;
    }
  /** No Analytics account yet: Google's terms page, one click, then back. */
  | { status: "needs_ga_account"; url: string | null }
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

/** What the setup needs to know about the site, from Shopify or from its address. */
interface SiteInfo {
  name: string;
  timeZone: string;
  currency: string;
  siteUrl: string;
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

/** The address the site really answers on (with or without www), as Search Console wants it. */
async function liveSiteUrl(domain: string): Promise<string> {
  const res = await fetch(`https://${domain}/`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SiteSetup/1.0)" }, redirect: "follow", signal: AbortSignal.timeout(12_000) }).catch(
    () => null
  );
  const final = res?.url ? new URL(res.url) : new URL(`https://${domain}/`);
  return `${final.protocol}//${final.host}/`;
}

/** Google's terms page for a new Analytics account, which returns to the app. */
async function gaAccountTicket(auth: GoogleAuth, name: string, returnTo: string): Promise<string | null> {
  const t = await googleRequest<{ accountTicketId?: string }>(auth, "https://analyticsadmin.googleapis.com/v1beta/accounts:provisionAccountTicket", {
    account: { displayName: name.slice(0, 100) || "My website", regionCode: "US" },
    redirectUri: returnTo,
  }).catch(() => null);
  return t?.accountTicketId ? `https://analytics.google.com/analytics/web/?provisioningSignup=false#/termsofservice/${t.accountTicketId}` : null;
}

/** The Analytics tag, for platforms that take header code. */
export const gtagCode = (id: string) =>
  `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","${id}");</script>`;

/** Creates a GA4 property and web stream for the site in the customer's Analytics account (one named after the site, or the first). */
async function createAnalytics(auth: GoogleAuth, info: { name: string; ianaTimezone: string; currencyCode: string; primaryDomain: { host: string } }, siteUrl: string): Promise<{ propertyId: string; measurementId: string } | null> {
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

/** The Analytics tag id the app created for this account, for the snippet to load. */
export async function setupMeasurementId(accountId: string): Promise<string | null> {
  return (await readSaved(accountId)).measurementId ?? null;
}

export async function setupGoogle(accountId: string, returnTo: string): Promise<SetupState> {
  const [conn, acct, profile, wp, snippetBefore] = await Promise.all([
    getConnection(accountId),
    readAccountAutopilot(accountId),
    readProfile(accountId),
    readWp(accountId).catch(() => null),
    snippetInstalled(accountId).catch(() => false),
  ]);
  if (!conn) throw new Error("Connect Google first.");
  const shop = acct.shopDomain && acct.shopTokenEnc ? { accountId, shopDomain: acct.shopDomain } : null;
  if (!shop && !profile.siteDomain) throw new Error("Connect your website first.");
  const auth: GoogleAuth = { kind: "oauth", refreshToken: conn.refreshToken };
  for (const scope of SETUP_SCOPES) if (!(await hasScope(auth, scope))) return { status: "needs_permission" };

  const saved = await readSaved(accountId);
  let info: SiteInfo;
  let installationId: string | null = null;
  if (shop) {
    const d = await shopifyGql<ShopInfo>(shop, "{ shop { name ianaTimezone currencyCode primaryDomain { host sslEnabled } } currentAppInstallation { id } }");
    installationId = d.currentAppInstallation.id;
    info = {
      name: d.shop.name,
      timeZone: d.shop.ianaTimezone,
      currency: d.shop.currencyCode,
      siteUrl: saved.siteUrl ?? `${d.shop.primaryDomain.sslEnabled ? "https" : "http"}://${d.shop.primaryDomain.host}/`,
    };
  } else {
    info = {
      name: profile.brandName ?? profile.siteDomain!,
      timeZone: "America/New_York",
      currency: "USD",
      siteUrl: saved.siteUrl ?? (await liveSiteUrl(profile.siteDomain!)),
    };
  }
  const siteUrl = info.siteUrl;
  // The snippet may have just been pasted together with the verification line.
  const snippet = snippetBefore || (!shop && !wp && profile.siteDomain ? await checkSnippet(accountId, profile.siteDomain).catch(() => false) : false);
  const notes: string[] = [];
  const next: Connection = { ...conn };

  try {
    // 1. The codes: Google's verification code, and an Analytics property when none is visible for this site.
    if (!conn.gscSiteUrl && !saved.verification) {
      const t = await googleRequest<{ token: string }>(auth, "https://www.googleapis.com/siteVerification/v1/token", {
        site: { type: "SITE", identifier: siteUrl },
        verificationMethod: "META",
      });
      saved.verification = t.token.match(/content="([^"]+)"/)?.[1] ?? t.token;
    }
    if (!conn.gaPropertyId && !saved.measurementId) {
      const created = await createAnalytics(
        auth,
        { name: info.name, ianaTimezone: info.timeZone, currencyCode: info.currency, primaryDomain: { host: new URL(siteUrl).host } },
        siteUrl
      );
      if (!created) return { status: "needs_ga_account", url: await gaAccountTicket(auth, info.name, returnTo) };
      Object.assign(saved, created);
      notes.push("Created a Google Analytics property for your site.");
    }
    await writeSaved(accountId, { ...saved, siteUrl });
    if (saved.propertyId && !conn.gaPropertyId) next.gaPropertyId = saved.propertyId;
    const verification = saved.verification && !conn.gscSiteUrl ? saved.verification : null;
    const measurement = saved.measurementId ?? null;

    // 2. The site shows them: automatically where the app can, otherwise a paste.
    if (shop && installationId) {
      const data: Record<string, string> = {};
      if (verification) data.gsc_verification = verification;
      if (measurement) data.ga_measurement_id = measurement;
      if (Object.keys(data).length) await setAppData(shop, installationId, data);
    } else if (wp) {
      await wpSetGoogle(wp, { verification, measurement });
    }
    const live = async (needle: string | null) => !needle || (await pageShows(siteUrl, needle));
    // The snippet loads the Analytics tag with JavaScript, so only the verification line has to be in the page itself.
    const gaShown = snippet || (await live(measurement));
    if (!(await live(verification)) || !gaShown) {
      if (next.gaPropertyId !== conn.gaPropertyId) await saveConnection(accountId, next);
      if (shop) return { status: "needs_embed", embedUrl: await embedUrl(shop) };
      if (!wp) {
        // Sites that take header code get the snippet in the same paste, which also loads Analytics.
        const headerCode = !["webflow", "wix"].includes(profile.platform ?? "");
        const snippetTag = !snippet && headerCode ? snippetTagFor(new URL(returnTo).origin, await snippetKey(accountId)) : null;
        return {
          status: "needs_paste",
          platform: profile.platform,
          verificationTag: verification ? `<meta name="google-site-verification" content="${verification}">` : null,
          verificationCode: verification,
          measurementId: snippet || snippetTag ? null : measurement,
          gtag: snippet || snippetTag || !measurement ? null : gtagCode(measurement),
          snippet,
          snippetTag,
        };
      }
      // WordPress shows them as soon as the plugin is updated; caches can take a moment.
      throw new Error("The plugin has the codes, but your site doesn't show them yet. Update the Insights Connector plugin (Plugins page), clear any cache plugin, then try again.");
    }

    // 3. Verify, add to Search Console, submit the sitemap.
    if (verification) {
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
