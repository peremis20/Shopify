import { readTargets } from "./autopilot/targets";
import { claimReport } from "./autopilot/claim-scan";
import { readAccountAutopilot } from "./autopilot/settings";
import { shopifyGql, shopName } from "./autopilot/shopify";
import { getConnection, saveConnection, type Connection } from "./connection";
import { ensureSchema, sql } from "./db";
import { googleRequest, type GoogleAuth } from "./google-auth";
import { listProperties } from "./properties";
import { bareDomain, BUSINESS_TYPES, readProfile, saveProfile, type Profile } from "./profile";
import { PLATFORM_LABEL, type Platform } from "./site-crawl";
import { readConnection } from "./autopilot/connections";
import { snippetInstalled } from "./autopilot/snippet";
import { readWp } from "./autopilot/wordpress";

/**
 * Guided setup, so nobody gets stuck: the app finds the customer's own
 * Search Console and Analytics properties by their store's domain, shows a
 * checklist of what's done and what's next, and writes the message to send
 * the site owner when the signed-in Google account can't see the site yet.
 */

export const APP_NAME = process.env.APP_NAME || "Insights";

// ---------- matching properties to the store ----------

/** The Search Console property for a domain: the domain property first, then the https and http site addresses. */
export function matchGscSite(sites: string[], domain: string): string | null {
  const d = domain.toLowerCase();
  const order = [`sc-domain:${d}`, `https://${d}/`, `https://www.${d}/`, `http://${d}/`, `http://www.${d}/`];
  for (const want of order) {
    const hit = sites.find((s) => s.toLowerCase() === want);
    if (hit) return hit;
  }
  return null;
}

/** Whether a chosen Search Console property belongs to the domain. */
export const gscBelongsTo = (site: string | undefined, domain: string) => Boolean(site && bareDomain(site) === domain);

interface Streams {
  dataStreams?: { type: string; webStreamData?: { defaultUri?: string; measurementId?: string } }[];
}

/** The website addresses an Analytics property collects from. */
async function propertyDomains(auth: GoogleAuth, id: string): Promise<string[]> {
  const d = await googleRequest<Streams>(auth, `https://analyticsadmin.googleapis.com/v1beta/properties/${id}/dataStreams?pageSize=50`).catch(
    () => ({}) as Streams
  );
  return (d.dataStreams ?? []).map((s) => bareDomain(s.webStreamData?.defaultUri)).filter((x): x is string => Boolean(x));
}

/** The Analytics property whose website stream is the store's domain, checking a few properties at a time. */
export async function matchGaProperty(auth: GoogleAuth, props: { id: string; name: string }[], domain: string): Promise<string | null> {
  const root = domain.split(".")[0];
  // Likely ones first: a property named after the site.
  const ordered = [...props].sort((a, b) => Number(b.name.toLowerCase().includes(root)) - Number(a.name.toLowerCase().includes(root))).slice(0, 40);
  for (let i = 0; i < ordered.length; i += 8) {
    const batch = ordered.slice(i, i + 8);
    const found = await Promise.all(batch.map(async (p) => ((await propertyDomains(auth, p.id)).includes(domain) ? p.id : null)));
    const hit = found.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

/** The store's own domain: saved in the profile, or read from the connected Shopify store. */
export async function storeDomain(accountId: string, profile?: Profile): Promise<string | null> {
  const p = profile ?? (await readProfile(accountId));
  if (p.siteDomain) return p.siteDomain;
  const acct = await readAccountAutopilot(accountId);
  if (!acct.shopDomain || !acct.shopTokenEnc) return null;
  const d = await shopifyGql<{ shop: { primaryDomain: { host: string } } }>(
    { accountId, shopDomain: acct.shopDomain },
    "{ shop { primaryDomain { host } } }"
  ).catch(() => null);
  const domain = bareDomain(d?.shop.primaryDomain.host);
  // A store still on its myshopify.com address has no site of its own in Google yet.
  if (domain && !domain.endsWith(".myshopify.com")) {
    await saveProfile(accountId, { siteDomain: domain });
    return domain;
  }
  return null;
}

export interface MatchResult {
  domain: string | null;
  gsc: "kept" | "matched" | "single" | "none";
  ga: "kept" | "matched" | "single" | "none";
}

/**
 * Fills in the Search Console and Analytics properties that aren't chosen
 * yet: the ones for the store's domain, or the only one there is. A choice
 * already made is never changed.
 */
export async function autoMatch(accountId: string, conn?: Connection | null): Promise<MatchResult> {
  const c = conn === undefined ? await getConnection(accountId) : conn;
  const domain = await storeDomain(accountId).catch(() => null);
  if (!c) return { domain, gsc: "none", ga: "none" };
  if (c.gscSiteUrl && c.gaPropertyId) return { domain, gsc: "kept", ga: "kept" };
  const auth: GoogleAuth = { kind: "oauth", refreshToken: c.refreshToken };
  const options = await listProperties(auth);
  const out: MatchResult = { domain, gsc: c.gscSiteUrl ? "kept" : "none", ga: c.gaPropertyId ? "kept" : "none" };
  let gsc = c.gscSiteUrl;
  let ga = c.gaPropertyId;
  if (!gsc) {
    const hit = domain ? matchGscSite(options.gsc.items, domain) : null;
    if (hit) [gsc, out.gsc] = [hit, "matched"];
    else if (options.gsc.items.length === 1) [gsc, out.gsc] = [options.gsc.items[0], "single"];
  }
  if (!ga) {
    const hit = domain ? await matchGaProperty(auth, options.ga.items, domain) : null;
    if (hit) [ga, out.ga] = [hit, "matched"];
    else if (options.ga.items.length === 1) [ga, out.ga] = [options.ga.items[0].id, "single"];
  }
  if (gsc !== c.gscSiteUrl || ga !== c.gaPropertyId) await saveConnection(accountId, { ...c, gscSiteUrl: gsc, gaPropertyId: ga });
  return out;
}

// ---------- asking the owner for access ----------

export interface AccessRequest {
  subject: string;
  body: string;
}

/** A plain message for the site owner, with the exact steps to add this Google account. */
export function accessRequest(domain: string, email: string, need: { gsc: boolean; ga: boolean }): AccessRequest {
  const steps: string[] = [];
  if (need.gsc) {
    steps.push(
      `Search Console: open https://search.google.com/search-console/users?resource_id=${encodeURIComponent(`sc-domain:${domain}`)} (pick ${domain} if it asks), click "Add user", enter ${email} and choose "Full".`
    );
  }
  if (need.ga) {
    steps.push(
      `Google Analytics: open https://analytics.google.com, click Admin (the gear, bottom left), then "Property access management", the blue + button, "Add users", enter ${email} and choose "Viewer".`
    );
  }
  const body = `Hi,

I'm setting up ${APP_NAME} to help ${domain} rank higher on Google. It needs to read the site's Google data, so could you give ${email} access? It takes about a minute:

${steps.map((s, i) => `${i + 1}. ${s}`).join("\n\n")}

Thank you!`;
  return { subject: `Quick favor: Google access for ${domain}`, body };
}

// ---------- the checklist ----------

export type StepId = "google" | "website" | "business" | "search_console" | "analytics" | "targets" | "first_check" | "preview" | "autopilot";

export interface Step {
  id: StepId;
  title: string;
  done: boolean;
  /** One plain sentence on where things stand. */
  detail: string;
}

export interface Onboarding {
  steps: Step[];
  complete: boolean;
  dismissed: boolean;
  domain: string | null;
  brandName: string | null;
  businessType: string | null;
  businessTypes: { id: string; label: string }[];
  /** Detected platform of a site connected by address (not Shopify). */
  platform: string | null;
  /** WordPress, Webflow or Wix sites: connected for automatic changes. */
  siteConnected: boolean;
  gaExcludeHosts: string[];
  /** Filled in when the Google account can't see the site's Search Console or Analytics. */
  access: AccessRequest | null;
  email: string | null;
}

async function hasPreview(accountId: string): Promise<boolean> {
  await ensureSchema();
  const rows = await sql`SELECT 1 FROM insights_autopilot_runs WHERE account_id = ${accountId} AND trigger = 'preview' AND status = 'done' LIMIT 1`;
  return rows.length > 0;
}

export async function onboardingStatus(accountId: string, email: string): Promise<Onboarding> {
  const [conn, acct, profile, wp] = await Promise.all([
    getConnection(accountId),
    readAccountAutopilot(accountId),
    readProfile(accountId, email),
    readWp(accountId).catch(() => null),
  ]);
  const [wf, wx] = await Promise.all([
    readConnection("webflow", accountId).catch(() => null),
    readConnection("wix", accountId).catch(() => null),
  ]);
  const snippet = await snippetInstalled(accountId).catch(() => false);
  const connectedTo = wp ? "WordPress" : wf ? "Webflow" : wx ? "Wix" : snippet ? "the snippet" : null;
  const shopConnected = Boolean(acct.shopDomain && acct.shopTokenEnc);
  const domain = await storeDomain(accountId, profile).catch(() => profile.siteDomain);
  const store = acct.shopDomain ? { accountId, shopDomain: acct.shopDomain } : null;
  const brand = profile.brandName ?? (shopConnected && store ? await shopName(store).catch(() => null) : null);
  const [claims, previewed, targets] = await Promise.all([
    claimReport(accountId).catch(() => null),
    hasPreview(accountId).catch(() => false),
    readTargets(accountId).catch(() => []),
  ]);

  const gscOk = Boolean(conn?.gscSiteUrl);
  const gaOk = Boolean(conn?.gaPropertyId);
  const gscWrong = gscOk && domain ? !gscBelongsTo(conn!.gscSiteUrl, domain) : false;
  const googleEmail = conn?.email ?? email;

  const steps: Step[] = [
    {
      id: "google",
      title: "Connect Google",
      done: Boolean(conn),
      detail: conn ? `Connected as ${conn.email ?? email}.` : "One Google sign in covers Search Console and Analytics.",
    },
    {
      id: "website",
      title: "Connect your website",
      done: shopConnected || Boolean(profile.siteDomain && profile.platform),
      detail: shopConnected
        ? `Connected to ${acct.shopDomain}. Approved improvements are made for you.`
        : connectedTo
          ? `Connected to ${connectedTo} (${profile.siteDomain}). Approved improvements are made for you${wx ? " on blog posts; the rest comes as a fix list" : snippet && !wp && !wf ? " (titles, descriptions, structured data, links); page text comes as a fix list" : ""}.`
          : profile.siteDomain && profile.platform
          ? `Reading ${profile.siteDomain} (${PLATFORM_LABEL[profile.platform as Platform] ?? profile.platform}). Changes come as a fix list you paste in, with where to paste each one.`
          : "Shopify stores connect in one click; any other website works too.",
    },
    {
      id: "business",
      title: "Tell us about your business",
      done: Boolean(profile.businessType),
      detail: profile.businessType
        ? `${brand ?? "Your site"}: ${BUSINESS_TYPES.find((b) => b.id === profile.businessType)?.label.toLowerCase()}.`
        : "So every change fits what you sell and stays within health claim rules.",
    },
    {
      id: "search_console",
      title: "Search Console",
      done: gscOk && !gscWrong,
      detail: !conn
        ? "Found automatically once Google is connected."
        : gscOk
          ? gscWrong
            ? `Using ${conn.gscSiteUrl}, which isn't ${domain}. Pick the right one.`
            : `Using ${conn.gscSiteUrl}.`
          : domain
            ? `${googleEmail} can't see ${domain} in Search Console yet.`
            : "Pick your site.",
    },
    {
      id: "analytics",
      title: "Google Analytics",
      done: gaOk,
      detail: !conn
        ? "Found automatically once Google is connected."
        : gaOk
          ? "Connected."
          : domain
            ? `${googleEmail} can't see an Analytics property for ${domain} yet.`
            : "Pick your Analytics property.",
    },
    {
      id: "targets",
      title: "Pick your first searches",
      done: targets.length > 0,
      detail: targets.length
        ? `${targets.length} search${targets.length === 1 ? "" : "es"} picked for the autopilot to rank for first.`
        : "The specific searches you can win, from studying your competitors.",
    },
    {
      id: "first_check",
      title: "Run the first site check",
      done: Boolean(claims?.checkedAt),
      detail: claims?.checkedAt ? "Health, claims and overlap checks are running weekly." : "Checks rankings, site health, risky claims and overlapping pages.",
    },
    {
      id: "preview",
      title: "Preview the first improvement",
      done: previewed,
      detail: previewed ? "You've seen what the autopilot would change." : "See exactly what the autopilot would change, before anything is written.",
    },
    {
      id: "autopilot",
      title: "Turn on the autopilot",
      done: acct.enabled,
      detail: acct.enabled ? "On. It improves a page a day within your weekly limit." : "Turn it on when you're happy with the preview.",
    },
  ];

  const needGsc = Boolean(conn) && !gscOk && Boolean(domain);
  const needGa = Boolean(conn) && !gaOk && Boolean(domain);
  return {
    steps,
    complete: steps.every((s) => s.done),
    dismissed: profile.onboardingDismissed,
    domain,
    brandName: brand,
    businessType: profile.businessType,
    businessTypes: BUSINESS_TYPES.map(({ id, label }) => ({ id, label })),
    platform: shopConnected ? "shopify" : profile.platform,
    siteConnected: Boolean(connectedTo),
    gaExcludeHosts: profile.gaExcludeHosts,
    access: needGsc || needGa ? accessRequest(domain!, googleEmail, { gsc: needGsc, ga: needGa }) : null,
    email: googleEmail,
  };
}
