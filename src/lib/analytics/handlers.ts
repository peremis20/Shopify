import crypto from "crypto";
import { currentAccount, readCookie, sessionCookie, upsertAccount, type Account } from "./accounts";
import { accountsDueForRun, autopilotHistory, logChange, markSuggestion, revertChange, runAutopilot } from "./autopilot/engine";
import { manualSite } from "./autopilot/site-source";
import { readSiteKeywords, refreshSiteKeywords } from "./autopilot/site-keywords";
import { addTarget, readTargets, removeTarget } from "./autopilot/targets";
import { deleteWp, saveWp, wpHello } from "./autopilot/wordpress";
import { deleteConnectionFor, saveConnectionFor } from "./autopilot/connections";
import { connectWebflow } from "./autopilot/webflow";
import { connectWix } from "./autopilot/wix";
import { checkSnippet, removeSnippet, SNIPPET_JS, snippetData, snippetInstalled, snippetKey, snippetTag } from "./autopilot/snippet";
import { crawlSite } from "./site-crawl";
import { claimReport, claimScanDue, scanSiteClaims, scanStoreClaims } from "./autopilot/claim-scan";
import { overlapReport, overlapScanDue, scanOverlap } from "./autopilot/overlap-scan";
import { applyLinkFix, describeFix, findLinkFixes, linkFixDue, markLinkFixChecked } from "./autopilot/link-fixer";
import {
  aiProvider,
  autopilotView,
  readAccountAutopilot,
  readPlatformSettings,
  saveAccountAutopilot,
  savePlatformSettings,
} from "./autopilot/settings";
import {
  authorizeUrl,
  completeInstall,
  normalizeShopDomain,
  shopName,
  SHOPIFY_STATE_COOKIE,
  verifyCallbackHmac,
  verifyWebhookHmac,
} from "./autopilot/shopify";
import { appStatuses } from "./autopilot/apps";
import { accountsDueForHealth, checkHealth, healthReport } from "./autopilot/health";
import { checkSerpKey } from "./autopilot/serp";
import { accountsDueForTracking, rankWatch, trackRanks } from "./autopilot/tracking";
import { checkAiKey } from "./autopilot/writer";
import { deleteConnection, getConnection, saveConnection, signInAvailable, STATE_COOKIE, type Connection } from "./connection";
import { ensureSchema, sql } from "./db";
import { isRangeKey } from "./dates";
import { ADS_OAUTH_SCOPES, exchangeAuthCode, OAUTH_SCOPES, revokeToken, SETUP_SCOPES } from "./google-auth";
import { KEYWORD_LANGUAGES, KEYWORD_LOCATIONS } from "./keyword-options";
import {
  explainAdsError,
  keywordIdeas,
  keywordStatus,
  keywordVolumes,
  saveAdsSettings,
  savePlatformAdsToken,
  type KeywordQuery,
} from "./keywords";
import { getOAuthClient, saveOAuthClient } from "./oauth-client";
import { adminAppUrl, embeddedAccount, googleLinkTicket, readLinkTicket } from "./embedded";
import { setupGoogle } from "./google-setup";
import { autoMatch, onboardingStatus } from "./onboarding";
import { getOverview } from "./overview";
import { bareDomain, readProfile, saveProfile } from "./profile";
import { listProperties } from "./properties";
import { addKeywords, createList, deleteList, findOpportunities, getLists, gscSearchCount, removeKeyword, THIN_GSC, trackRankings } from "./seo-tools";
import type { Opportunity } from "./seo-types";

/**
 * Every API route as a plain web handler (Request in, Response out), shared
 * by the Next.js routes and the Neon Function. Customers are identified by
 * the signed session cookie set when they sign in with Google; all data is
 * scoped to their account.
 */

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The public address of the app. Set APP_URL when it sits behind a proxy. */
export function appOrigin(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export const redirectUri = (req: Request) => `${appOrigin(req)}/api/auth/google/callback`;
const shopifyRedirectUri = (req: Request) => `${appOrigin(req)}/api/shopify/callback`;

function tempCookie(req: Request, name: string, value: string, maxAge: number): string {
  const secure = appOrigin(req).startsWith("https:") ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function redirect(location: string, ...cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  cookies.forEach((c) => headers.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers });
}

const signedOut = () => json({ error: "Please sign in.", signedIn: false }, 401);

/** Runs a handler only for a signed-in account. */
/** The signed-in account: the session cookie, or inside Shopify admin the store's session token. */
async function accountOf(req: Request): Promise<Account | null> {
  return (await currentAccount(req)) ?? (await embeddedAccount(req));
}

async function withAccount(req: Request, run: (account: Account) => Promise<Response>): Promise<Response> {
  let account: Account | null;
  try {
    account = await accountOf(req);
  } catch (err) {
    return json({ error: message(err) }, 500);
  }
  if (!account) return signedOut();
  try {
    return await run(account);
  } catch (err) {
    return json({ error: message(err) }, 500);
  }
}

const withAdmin = (req: Request, run: (account: Account) => Promise<Response>) =>
  withAccount(req, (a) => (a.admin ? run(a) : Promise.resolve(json({ error: "Only the platform owner can do this." }, 403))));

// ---------- session and Google sign-in ----------

export async function session(req: Request): Promise<Response> {
  const account = await accountOf(req).catch(() => null);
  return json({
    signedIn: Boolean(account),
    email: account?.email,
    admin: account?.admin ?? false,
    signInAvailable: await signInAvailable().catch(() => false),
  });
}

/** Sends the visitor to Google. purpose=ads is the owner's one-time Google Ads connection. */
export async function authStart(req: Request): Promise<Response> {
  const client = await getOAuthClient();
  if (!client || !(await signInAvailable())) {
    return redirect(`${appOrigin(req)}/analytics?auth_error=Sign+in+is+not+set+up+yet`);
  }
  const asked = new URL(req.url).searchParams.get("purpose");
  // "setup" adds the permissions "Set it up for me" needs, on top of what was already granted.
  const purpose = asked === "ads" ? "ads" : asked === "setup" ? "setup" : "signin";
  if (purpose === "ads" && !(await currentAccount(req))?.admin) {
    return redirect(`${appOrigin(req)}/analytics?auth_error=Only+the+platform+owner+can+connect+Google+Ads`);
  }
  // From inside Shopify admin: a signed ticket says which account the Google connection is for.
  const ticket = new URL(req.url).searchParams.get("link");
  const linked = purpose !== "ads" && readLinkTicket(ticket) ? `link~${ticket}` : purpose;
  const state = `${linked}.${crypto.randomBytes(16).toString("hex")}`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: (purpose === "ads" ? ADS_OAUTH_SCOPES : purpose === "setup" ? [...OAUTH_SCOPES, ...SETUP_SCOPES] : OAUTH_SCOPES).join(" "),
    include_granted_scopes: "true",
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return redirect(url.toString(), tempCookie(req, STATE_COOKIE, state, 600));
}

/** Google redirects here. Signs the customer in (creating the account) and saves their connection. */
export async function authCallback(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const clearState = tempCookie(req, STATE_COOKIE, "", 0);
  const back = (p: Record<string, string>, ...cookies: string[]) =>
    redirect(`${appOrigin(req)}/analytics?${new URLSearchParams(p)}`, clearState, ...cookies);

  const error = params.get("error");
  if (error) return back({ auth_error: error === "access_denied" ? "Google access was not granted" : error });

  const state = params.get("state");
  const code = params.get("code");
  // Back from accepting Google Analytics' terms (Set it up for me): no sign in to finish, just continue setup.
  if (!code && !state) return redirect(`${appOrigin(req)}/analytics?ga_ready=1`, clearState);
  if (!code || !state || state !== readCookie(req, STATE_COOKIE)) {
    return back({ auth_error: "The sign in link expired. Please try again." });
  }

  try {
    const { refreshToken, email } = await exchangeAuthCode(code, redirectUri(req));
    if (!refreshToken || !email) throw new Error("Google didn't return the needed access. Please try again.");

    if (state.startsWith("ads.")) {
      if (!(await currentAccount(req))?.admin) throw new Error("Only the platform owner can connect Google Ads.");
      await savePlatformAdsToken(refreshToken);
      return back({ connected: "ads" });
    }

    const link = state.startsWith("link~") ? readLinkTicket(state.slice(5, state.lastIndexOf("."))) : null;
    if (state.startsWith("link~") && !link) throw new Error("The link from Shopify expired. Please try again from the app.");
    const account = link ? { id: link.accountId } : await upsertAccount(email);
    // Keep the properties already chosen when a customer signs in again; find the rest by the store's domain.
    const previous = await getConnection(account.id).catch(() => null);
    const conn = { refreshToken, email, gaPropertyId: previous?.gaPropertyId, gscSiteUrl: previous?.gscSiteUrl };
    await saveConnection(account.id, conn);
    await autoMatch(account.id, conn).catch(() => undefined);
    // Back into Shopify admin when the sign in started there.
    if (link) return redirect(link.returnTo || `${appOrigin(req)}/analytics`, clearState);
    // Signed in on the way to connecting WordPress: finish that now.
    if (readCookie(req, WP_PENDING_COOKIE)) return redirect(`${appOrigin(req)}/api/wordpress/connect`, clearState, sessionCookie(req, account.id));
    return back(previous ? {} : { connected: "1" }, sessionCookie(req, account.id));
  } catch (err) {
    return back({ auth_error: message(err) });
  }
}

export async function logout(req: Request): Promise<Response> {
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(req, null) });
}

/** Removes the customer's Google connection and signs them out. */
export async function disconnect(req: Request): Promise<Response> {
  return withAccount(req, async (account) => {
    const conn = await getConnection(account.id);
    if (conn) await revokeToken(conn.refreshToken);
    await deleteConnection(account.id);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(req, null) });
  });
}

/** Saves the platform's Google OAuth client: by the admin, or once at first setup. */
export async function saveGoogleClient(req: Request): Promise<Response> {
  const account = await currentAccount(req).catch(() => null);
  if (!account?.admin && (await getOAuthClient())) return json({ error: "Only the platform owner can do this." }, 403);
  const body = await req.json().catch(() => ({}));
  const id = typeof body.clientId === "string"
    ? body.clientId.match(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/)?.[0] ?? ""
    : "";
  const secret = typeof body.clientSecret === "string"
    ? body.clientSecret.replace(/^[\s\S]*?(GOCSPX-)/, "$1").replace(/\s+/g, "")
    : "";
  if (!id) return json({ error: "That doesn't look like a Client ID. It ends with .apps.googleusercontent.com" }, 400);
  if (secret.length < 10) return json({ error: "Paste the full Client secret from Google Cloud." }, 400);
  try {
    await saveOAuthClient({ id, secret });
    return json({ ok: true });
  } catch (err) {
    return json({ error: message(err) }, 400);
  }
}

// ---------- WordPress ----------

const WP_PENDING_COOKIE = "insights_wp_pending";

/**
 * "Connect to Insights" in the WordPress plugin lands here with the site, its
 * private key and where to go back to. Signs in first if needed, checks the
 * plugin answers with that key, saves the connection and returns to WordPress.
 */
export async function wordpressConnect(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const pending = readCookie(req, WP_PENDING_COOKIE);
  const fromCookie = pending ? new URLSearchParams(pending) : null;
  const site = params.get("site") ?? fromCookie?.get("site") ?? "";
  const key = params.get("key") ?? fromCookie?.get("key") ?? "";
  const backTo = params.get("back") ?? fromCookie?.get("back") ?? "";
  const clear = tempCookie(req, WP_PENDING_COOKIE, "", 0);
  let origin: string;
  try {
    origin = new URL(site).origin;
  } catch {
    return redirect(`${appOrigin(req)}/analytics?auth_error=${encodeURIComponent("That WordPress link was incomplete. Click Connect to Insights again.")}`, clear);
  }
  // Only ever send people back to their own site's admin.
  const back = (p: Record<string, string>) =>
    redirect(`${backTo.startsWith(origin) ? backTo : `${origin}/wp-admin/options-general.php?page=insights-connector`}&${new URLSearchParams(p)}`, clear);

  const account = await currentAccount(req).catch(() => null);
  if (!account) {
    // Sign in first; the Google callback comes back here.
    const keep = new URLSearchParams({ site, key, back: backTo }).toString();
    return redirect(`${appOrigin(req)}/api/auth/google/start`, tempCookie(req, WP_PENDING_COOKIE, encodeURIComponent(keep), 900));
  }
  try {
    const hello = await wpHello(site, key);
    await saveWp(account.id, { site: hello.home || site, key, name: hello.name, seoPlugin: hello.seo_plugin });
    await saveProfile(account.id, { siteDomain: new URL(hello.home || site).hostname, platform: "wordpress" });
    await autoMatch(account.id).catch(() => undefined);
    return back({ connected: "1" });
  } catch (err) {
    return back({ insights_error: message(err) });
  }
}

/** The WordPress plugin to download (served with the page assets). */
export async function wordpressPlugin(req: Request): Promise<Response> {
  const assets = (process.env.ASSET_BASE_URL ?? "").replace(/\/$/, "");
  return redirect(assets ? `${assets}/insights-connector.zip` : `${appOrigin(req)}/insights-connector.zip`);
}

export const wordpressDisconnect = (req: Request) =>
  withAccount(req, async (account) => {
    await deleteWp(account.id);
    return json({ settings: await autopilotView(account.id, account.admin) });
  });

// ---------- Webflow and Wix ----------

/** Webflow: a site token (Sites, Pages and CMS read and write) for the site at the account's domain. */
export const webflowConnect = (req: Request) =>
  withAccount(req, async (account) => {
    const b = await req.json().catch(() => ({}));
    const token = typeof b.token === "string" ? b.token.trim() : "";
    const profile = await readProfile(account.id);
    if (!profile.siteDomain) return json({ error: "Connect your website by its address first." }, 400);
    if (token.length < 20) return json({ error: "Paste the whole API token from Webflow." }, 400);
    try {
      await saveConnectionFor("webflow", account.id, await connectWebflow(token, profile.siteDomain));
      await saveProfile(account.id, { platform: "webflow" });
      return json({ settings: await autopilotView(account.id, account.admin) });
    } catch (err) {
      return json({ error: message(err) }, 400);
    }
  });

/** Wix: an API key with Wix Blog permissions, and the site's id. */
export const wixConnect = (req: Request) =>
  withAccount(req, async (account) => {
    const b = await req.json().catch(() => ({}));
    const apiKey = typeof b.apiKey === "string" ? b.apiKey.trim() : "";
    // The site id is the long id in the Wix dashboard address; accept the whole address too.
    const siteId = (typeof b.siteId === "string" ? b.siteId : "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? "";
    if (apiKey.length < 20) return json({ error: "Paste the whole API key from Wix." }, 400);
    if (!siteId) return json({ error: "Paste the site id (or your Wix dashboard address, which contains it)." }, 400);
    if (!(await readProfile(account.id)).siteDomain) return json({ error: "Connect your website by its address first." }, 400);
    try {
      await connectWix({ apiKey, siteId });
      await saveConnectionFor("wix", account.id, { apiKey, siteId });
      await saveProfile(account.id, { platform: "wix" });
      return json({ settings: await autopilotView(account.id, account.admin) });
    } catch (err) {
      return json({ error: message(err) }, 400);
    }
  });

/** Disconnects WordPress, Webflow or Wix (changes go back to the fix list). */
export const siteDisconnect = (req: Request) =>
  withAccount(req, async (account) => {
    const b = await req.json().catch(() => ({}));
    if (b.kind === "webflow" || b.kind === "wix") await deleteConnectionFor(b.kind, account.id);
    else if (b.kind === "snippet") await removeSnippet(account.id);
    else await deleteWp(account.id);
    return json({ settings: await autopilotView(account.id, account.admin) });
  });

// ---------- the one-line snippet ----------

/** The snippet script sites load (public). */
export async function snippetScript(): Promise<Response> {
  return new Response(SNIPPET_JS, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

/** What the snippet changes on one page (public, readable from any site). */
export async function snippetDataHandler(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const data = await snippetData(params.get("k") ?? "", params.get("u") ?? "/").catch(() => null);
  return new Response(JSON.stringify(data ?? {}), {
    status: data ? 200 : 404,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}

/** The account's snippet tag and whether it's on the site. */
export const snippetStatus = (req: Request) =>
  withAccount(req, async (account) => {
    const siteKey = await snippetKey(account.id);
    return json({ tag: snippetTag(appOrigin(req), siteKey), installed: await snippetInstalled(account.id) });
  });

/** "Check installation": looks for the snippet on the live home page. */
export const snippetCheck = (req: Request) =>
  withAccount(req, async (account) => {
    const profile = await readProfile(account.id);
    if (!profile.siteDomain) return json({ error: "Connect your website by its address first." }, 400);
    const installed = await checkSnippet(account.id, profile.siteDomain);
    const siteKey = await snippetKey(account.id);
    return json({
      tag: snippetTag(appOrigin(req), siteKey),
      installed,
      error: installed ? undefined : `The snippet isn't on ${profile.siteDomain}'s home page yet. Publish your site after adding it, then check again.`,
      settings: await autopilotView(account.id, account.admin),
    });
  });

// ---------- inside Shopify admin ----------

export { APP_NAME } from "./onboarding";

/** The Shopify app's public key, for App Bridge on the embedded page. */
export async function embeddedAppKey(): Promise<string | null> {
  return (await readPlatformSettings()).shopifyClientId ?? null;
}

/**
 * A Google sign in link tied to this account: from inside Shopify admin it
 * opens at the top level and comes back into the app; purpose=setup also asks
 * for the "Set it up for me" permissions.
 */
export const googleLinkStart = (req: Request) =>
  withAccount(req, async (account) => {
    const acct = await readAccountAutopilot(account.id);
    const embedded = Boolean(req.headers.get("authorization"));
    const back = embedded && acct.shopDomain ? await adminAppUrl(acct.shopDomain) : `${appOrigin(req)}/analytics`;
    const purpose = new URL(req.url).searchParams.get("purpose") === "setup" ? "&purpose=setup" : "";
    return json({ url: `${appOrigin(req)}/api/auth/google/start?link=${encodeURIComponent(googleLinkTicket(account.id, back))}${purpose}` });
  });

/** "Set it up for me": creates Search Console and Analytics for a store that has neither. */
export const setupGoogleTools = (req: Request) =>
  withAccount(req, async (account) => {
    // A new Analytics account comes back through the Google callback (an address the OAuth client already allows).
    const state = await setupGoogle(account.id, redirectUri(req));
    return json({ state, onboarding: await onboardingStatus(account.id, account.email) });
  });

// ---------- onboarding ----------

/** The setup checklist, with the owner access message when needed. */
export const onboarding = (req: Request) => withAccount(req, async (account) => json(await onboardingStatus(account.id, account.email)));

/** Saves what the business is (and hides or shows the checklist). */
export const saveOnboardingProfile = (req: Request) =>
  withAccount(req, async (account) => {
    const b = await req.json().catch(() => ({}));
    await saveProfile(account.id, {
      brandName: typeof b.brandName === "string" ? b.brandName : undefined,
      businessType: typeof b.businessType === "string" ? b.businessType : undefined,
      gaExcludeHosts: typeof b.gaExcludeHosts === "string" ? b.gaExcludeHosts.split(",") : undefined,
      onboardingDismissed: typeof b.dismissed === "boolean" ? b.dismissed : undefined,
    });
    return json(await onboardingStatus(account.id, account.email));
  });

/**
 * "Another website": any site the app reads but can't edit (WordPress, Wix,
 * custom...). Saves its address, reads its first pages and detects the
 * platform, then finds its Google properties.
 */
export const connectWebsite = (req: Request) =>
  withAccount(req, async (account) => {
    const b = await req.json().catch(() => ({}));
    const domain = bareDomain(typeof b.domain === "string" ? b.domain : "");
    if (!domain) return json({ error: "Enter your website address, like example.com." }, 400);
    await saveProfile(account.id, { siteDomain: domain });
    const { platform } = await crawlSite(account.id, domain, 15);
    await saveProfile(account.id, { platform: platform ?? "custom" });
    await autoMatch(account.id).catch(() => undefined);
    return json(await onboardingStatus(account.id, account.email));
  });

/** Looks for the Search Console and Analytics properties again (after the owner granted access). */
export const rematchProperties = (req: Request) =>
  withAccount(req, async (account) => {
    await autoMatch(account.id);
    return json(await onboardingStatus(account.id, account.email));
  });

// ---------- analytics ----------

export async function overview(req: Request): Promise<Response> {
  return withAccount(req, async (account) => {
    const params = new URL(req.url).searchParams;
    const range = params.get("range");
    const data = await getOverview(
      account.id,
      isRangeKey(range) ? range : "28d",
      await getConnection(account.id),
      redirectUri(req),
      params.get("refresh") === "1",
      (await readProfile(account.id, account.email)).gaExcludeHosts
    );
    return json({ ...data, account: { email: account.email, admin: account.admin } });
  });
}

export async function properties(req: Request): Promise<Response> {
  return withAccount(req, async (account) => {
    const conn = await getConnection(account.id);
    if (!conn) return json({ error: "Sign in with Google again." }, 401);
    return json(await listProperties({ kind: "oauth", refreshToken: conn.refreshToken }));
  });
}

/** Saves which GA4 property and Search Console site the dashboard reads. */
export async function saveSettings(req: Request): Promise<Response> {
  return withAccount(req, async (account) => {
    const conn = await getConnection(account.id);
    if (!conn) return json({ error: "Sign in with Google again." }, 401);
    const body = await req.json().catch(() => ({}));
    const gaPropertyId = typeof body.gaPropertyId === "string" ? body.gaPropertyId.trim() : "";
    const gscSiteUrl = typeof body.gscSiteUrl === "string" ? body.gscSiteUrl.trim() : "";
    if (gaPropertyId && !/^\d+$/.test(gaPropertyId)) {
      return json({ error: "That Google Analytics property ID doesn't look right." }, 400);
    }
    await saveConnection(account.id, { ...conn, gaPropertyId: gaPropertyId || undefined, gscSiteUrl: gscSiteUrl || undefined });
    return json({ ok: true });
  });
}

// ---------- keyword research (runs on the platform's Google Ads account) ----------

export const keywordSetup = (req: Request) =>
  withAccount(req, async (account) => json(await keywordStatus(account.admin)));

export const saveKeywordSettings = (req: Request) =>
  withAdmin(req, async () => {
    const body = await req.json().catch(() => ({}));
    const pick = (k: string) => (typeof body[k] === "string" ? body[k] : undefined);
    const developerToken = pick("developerToken")?.replace(/\s+/g, "");
    if (developerToken !== undefined && developerToken.length < 15) {
      return json({ error: "Paste the full developer token from Google Ads (Admin, then API Center)." }, 400);
    }
    await saveAdsSettings({ developerToken, customerId: pick("customerId"), loginCustomerId: pick("loginCustomerId") });
    return json({ ok: true });
  });

function readKeywordQuery(body: Record<string, unknown>): KeywordQuery {
  const list = Array.isArray(body.keywords)
    ? body.keywords
    : typeof body.keywords === "string"
      ? body.keywords.split(/[,\n]/)
      : [];
  const geo = typeof body.geo === "string" && KEYWORD_LOCATIONS.some((l) => l.id === body.geo) ? body.geo : "2840";
  const language = typeof body.language === "string" && KEYWORD_LANGUAGES.some((l) => l.id === body.language)
    ? body.language
    : "1000";
  return {
    keywords: list.map((k) => String(k).trim()).filter(Boolean),
    url: typeof body.url === "string" && body.url.trim() ? body.url.trim() : undefined,
    geo,
    language,
  };
}

/** Customers get a plain message; the platform owner gets the exact reason. */
const keywordError = (account: Account, err: unknown) =>
  json({ error: account.admin ? explainAdsError(err) : "Keyword data isn't available right now. Please try again later." }, 502);

export const keywordIdeasHandler = (req: Request) =>
  withAccount(req, async (account) => {
    const q = readKeywordQuery(await req.json().catch(() => ({})));
    if (!q.keywords.length && !q.url) return json({ error: "Enter a keyword or a website address." }, 400);
    try {
      return json({ ideas: await keywordIdeas(q) });
    } catch (err) {
      return keywordError(account, err);
    }
  });

export const keywordVolumesHandler = (req: Request) =>
  withAccount(req, async (account) => {
    const q = readKeywordQuery(await req.json().catch(() => ({})));
    if (!q.keywords.length) return json({ error: "There are no keywords to look up yet." }, 400);
    try {
      return json({ ideas: await keywordVolumes(q) });
    } catch (err) {
      return keywordError(account, err);
    }
  });

// ---------- SEO tools ----------

export const opportunities = (req: Request) =>
  withAccount(req, async (account) => {
    const conn = await getConnection(account.id);
    if (!conn) return json({ error: "Sign in with Google again." }, 401);
    const range = new URL(req.url).searchParams.get("range");
    try {
      const found = conn.gscSiteUrl ? await findOpportunities(conn, isRangeKey(range) ? range : "28d").catch(() => []) : [];
      if (found.length) return json({ opportunities: found, source: "search-console" });
      // Search Console has nothing yet: the searches each page should win, from Keyword Planner, with today's Google position.
      return json({ opportunities: await plannerOpportunities(account.id, conn), source: "keyword-planner" });
    } catch (err) {
      return json({ error: message(err) }, 502);
    }
  });

/** Not on Google page one for a search: shown as page two or three. */
const OFF_PAGE_ONE = 25;

async function plannerOpportunities(accountId: string, conn: Connection): Promise<Opportunity[]> {
  let kws = await readSiteKeywords(accountId);
  if (!kws.length) {
    const profile = await readProfile(accountId);
    const domain = conn.gscSiteUrl ? domainOf(conn.gscSiteUrl) : profile.siteDomain;
    const { serperKey } = await readPlatformSettings();
    if (domain) kws = await refreshSiteKeywords(accountId, profile.brandName ?? domain.split(".")[0], serperKey, domain);
  }
  const ranks = new Map((await rankWatch(accountId)).map((r) => [r.query, r]));
  return kws
    .map((k) => {
      const r = ranks.get(k.keyword);
      return {
        query: k.keyword,
        page: (r?.url ?? k.page).split("#")[0],
        position: r ? (r.position ?? OFF_PAGE_ONE) : 0,
        impressions: 0,
        clicks: 0,
        ctr: 0,
        potentialClicks: Math.round(k.monthlySearches * 0.1),
        monthlySearches: k.monthlySearches,
        checked: Boolean(r),
        why: k.why,
        winnable: k.winnable,
        role: k.role ?? "main",
      };
    })
    .filter((o) => o.position !== 1)
    // Long tail main targets first; broad supporting searches after.
    .sort((a, b) => Number(a.role === "support") - Number(b.role === "support"));
}

/** "Rank for this": matches the search to a page, checks Google page one, and hands it to the autopilot. */
export const rankForThis = (req: Request) =>
  withAccount(req, async (account) => {
    const body = (await req.json().catch(() => ({}))) as { keyword?: string; monthlySearches?: number; remove?: boolean };
    const keyword = (body.keyword ?? "").trim();
    if (!keyword || keyword.length > 120) return json({ error: "Pick a search first." }, 400);
    if (body.remove) {
      await removeTarget(account.id, keyword);
      return json({ ok: true });
    }
    const [conn, profile, platform] = await Promise.all([getConnection(account.id), readProfile(account.id), readPlatformSettings()]);
    const ourDomain = conn?.gscSiteUrl ? domainOf(conn.gscSiteUrl) : (profile.siteDomain ?? "");
    try {
      return json(await addTarget(account.id, keyword, { serperKey: platform.serperKey ?? null, ourDomain, monthlySearches: body.monthlySearches }));
    } catch (err) {
      return json({ error: message(err) }, 502);
    }
  });

export const rankTargets = (req: Request) => withAccount(req, async (account) => json({ targets: await readTargets(account.id) }));

export const keywordLists = (req: Request) =>
  withAccount(req, async (account) => json({ lists: await getLists(account.id) }));

/** One endpoint for list changes: create, delete, add keywords, remove a keyword. */
export const updateKeywordLists = (req: Request) =>
  withAccount(req, async (account) => {
    const body = await req.json().catch(() => ({}));
    const str = (k: string) => (typeof body[k] === "string" ? body[k].trim() : "");
    switch (body.action) {
      case "create": {
        const name = str("name").slice(0, 80);
        if (!name) return json({ error: "Give the list a name." }, 400);
        const list = await createList(account.id, name);
        if (Array.isArray(body.keywords)) await addKeywords(account.id, list.id, body.keywords.map(String));
        break;
      }
      case "delete":
        await deleteList(account.id, str("listId"));
        break;
      case "add":
        if (!Array.isArray(body.keywords)) return json({ error: "No keywords to add." }, 400);
        await addKeywords(account.id, str("listId"), body.keywords.map(String));
        break;
      case "remove":
        await removeKeyword(account.id, str("listId"), str("keyword"));
        break;
      default:
        return json({ error: "Unknown action." }, 400);
    }
    return json({ lists: await getLists(account.id) });
  });

export const rankings = (req: Request) =>
  withAccount(req, async (account) => {
    const conn = await getConnection(account.id);
    if (!conn) return json({ error: "Sign in with Google again." }, 401);
    const listId = new URL(req.url).searchParams.get("listId");
    const list = (await getLists(account.id)).find((l) => l.id === listId);
    if (!list) return json({ error: "That list doesn't exist anymore." }, 404);
    try {
      return json({ rankings: await trackRankings(conn, list.keywords) });
    } catch (err) {
      return json({ error: message(err) }, 502);
    }
  });

// ---------- autopilot ----------

export const autopilotStatus = (req: Request) =>
  withAccount(req, async (account) => {
    const [conn, platform] = await Promise.all([getConnection(account.id), readPlatformSettings()]);
    const apps = conn
      ? await appStatuses({ accountId: account.id, conn, platform, ourDomain: "", shared: new Map() }).catch(() => [])
      : [];
    return json({ settings: await autopilotView(account.id, account.admin), apps, ...(await autopilotHistory(account.id)) });
  });

/** The customer's own choices: on/off, pages per week, content sections. */
export const saveAutopilot = (req: Request) =>
  withAccount(req, async (account) => {
    const b = await req.json().catch(() => ({}));
    await saveAccountAutopilot(account.id, {
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
      maxPagesPerWeek: typeof b.maxPagesPerWeek === "number" ? b.maxPagesPerWeek : undefined,
      articlesPerWeek: typeof b.articlesPerWeek === "number" ? b.articlesPerWeek : undefined,
      allowContent: typeof b.allowContent === "boolean" ? b.allowContent : undefined,
    });
    return json({ settings: await autopilotView(account.id, account.admin) });
  });

/** The platform owner's keys: Claude, and the public Shopify app. */
export const savePlatform = (req: Request) =>
  withAdmin(req, async (account) => {
    const b = await req.json().catch(() => ({}));
    const str = (k: string) => (typeof b[k] === "string" ? b[k] : undefined);
    await savePlatformSettings({
      anthropicKey: str("anthropicKey"),
      geminiKey: str("geminiKey"),
      groqKey: str("groqKey"),
      githubModelsKey: str("githubModelsKey"),
      serperKey: str("serperKey"),
      pagespeedKey: str("pagespeedKey"),
      shopifyClientId: str("shopifyClientId"),
      shopifyClientSecret: str("shopifyClientSecret"),
    });
    const p = await readPlatformSettings();
    let claude: string | undefined;
    const ai = aiProvider(p);
    const NAMES = { claude: "Claude", groq: "Groq", github: "GitHub Models", gemini: "Gemini" } as const;
    if (ai) {
      const problems: string[] = [];
      for (const one of [ai, ...(ai.backups ?? [])]) {
        await checkAiKey(one).catch((e) => problems.push(`${NAMES[one.kind]}: ${message(e)}`));
      }
      if (problems.length) claude = problems.join(" ");
    }
    if (str("serperKey")?.trim() && p.serperKey) {
      await checkSerpKey(p.serperKey).catch((e) => (claude = [claude, message(e)].filter(Boolean).join(" ")));
    }
    return json({ settings: await autopilotView(account.id, true), claudeError: claude });
  });

const domainOf = (site: string) => new URL(site.replace(/^sc-domain:/, "https://")).hostname.replace(/^www\./, "");

/** Weekly: points blog and page links at renamed products' live addresses. Only with autopilot on, or on "Check now". */
async function fixLinks(accountId: string, force: boolean): Promise<number> {
  const acct = await readAccountAutopilot(accountId);
  if (!acct.shopDomain || !acct.shopTokenEnc || !(acct.enabled || force) || !(force || (await linkFixDue(accountId)))) return 0;
  const store = { accountId, shopDomain: acct.shopDomain };
  let fixed = 0;
  for (const f of await findLinkFixes(store)) {
    if (!(await applyLinkFix(store, f).catch(() => false))) continue;
    await logChange({
      accountId, runId: null, pageUrl: f.url, resourceType: f.type, resourceId: f.id, query: "", field: "link_fix",
      before: f.before, after: f.after, reason: describeFix(f), status: "kept",
    });
    fixed += f.links.reduce((a, l) => a + l.count, 0);
  }
  await markLinkFixChecked(accountId);
  return fixed;
}

/** Weekly claim guard scan of the whole store (read only), whenever a store is connected. */
async function runClaimScan(accountId: string, force: boolean): Promise<number> {
  const acct = await readAccountAutopilot(accountId);
  if (!(force || (await claimScanDue(accountId)))) return 0;
  if (acct.shopDomain && acct.shopTokenEnc) return scanStoreClaims(accountId, { accountId, shopDomain: acct.shopDomain });
  return (await readProfile(accountId)).siteDomain ? scanSiteClaims(accountId) : 0;
}

/** Weekly overlap check: duplicate titles and descriptions, near duplicate posts, pages competing for a search. */
async function runOverlapScan(accountId: string, conn: Connection | null, force: boolean): Promise<number> {
  const acct = await readAccountAutopilot(accountId);
  if (!(force || (await overlapScanDue(accountId)))) return 0;
  const brand = conn?.gscSiteUrl ? domainOf(conn.gscSiteUrl).split(".")[0] : "";
  if (acct.shopDomain && acct.shopTokenEnc) return scanOverlap(accountId, { accountId, shopDomain: acct.shopDomain }, conn, brand);
  const profile = await readProfile(accountId);
  if (!profile.siteDomain) return 0;
  return scanOverlap(accountId, await manualSite(accountId, brand).index(), conn, brand);
}

/** Websites the app can't edit: read their pages from the sitemap (new and week-old pages, a batch a day). */
async function readSite(accountId: string, force: boolean): Promise<number> {
  const [acct, conn] = await Promise.all([readAccountAutopilot(accountId), getConnection(accountId)]);
  // Shopify stores are read through Shopify, unless there's no Search Console: then their pages feed the keyword targets.
  if (acct.shopDomain && acct.shopTokenEnc && conn?.gscSiteUrl) return 0;
  const profile = await readProfile(accountId);
  if (!profile.siteDomain) return 0;
  const { read, platform } = await crawlSite(accountId, profile.siteDomain, force ? 25 : 60);
  if (platform && platform !== profile.platform) await saveProfile(accountId, { platform });
  return read;
}

/** Today's rank check, a few page health checks, and the weekly link fix, claim and overlap checks for one account. Each part runs at most once a day. */
async function maintain(accountId: string, force = false): Promise<string> {
  const [conn, platform] = await Promise.all([getConnection(accountId), readPlatformSettings()]);
  const links = await fixLinks(accountId, force).catch((e) => (console.error(`link fix failed: ${message(e)}`), 0));
  const read = await readSite(accountId, force).catch((e) => (console.error(`site read failed: ${message(e)}`), 0));
  const claims = await runClaimScan(accountId, force).catch((e) => (console.error(`claim scan failed: ${message(e)}`), 0));
  const overlaps = await runOverlapScan(accountId, conn, force).catch((e) => (console.error(`overlap scan failed: ${message(e)}`), 0));
  const profile = await readProfile(accountId);
  const domain = conn?.gscSiteUrl ? domainOf(conn.gscSiteUrl) : profile.siteDomain;
  if (!conn || !domain) return `no website yet, pages read ${read}, links ${links}, claims ${claims}, overlaps ${overlaps}`;
  // Without Search Console, or while it has too little data (new property, small site), Keyword Planner picks the searches to track for each page.
  const thin = !conn.gscSiteUrl || (await gscSearchCount(conn).catch(() => 0)) < THIN_GSC;
  const picked = thin
    ? (await refreshSiteKeywords(accountId, profile.brandName ?? domain.split(".")[0], platform.serperKey, domain).catch((e) => (console.error(`site keywords failed: ${message(e)}`), []))).length
    : 0;
  const ranks = platform.serperKey ? await trackRanks(accountId, conn, platform.serperKey, domain).catch(() => 0) : 0;
  // Index status needs Search Console's URL Inspection.
  const pages = conn.gscSiteUrl ? await checkHealth(accountId, conn, platform.pagespeedKey, force ? 8 : undefined).catch(() => 0) : 0;
  return `ranks ${ranks}, health ${pages}, keywords ${picked}, pages read ${read}, links ${links}, claims ${claims}, overlaps ${overlaps}`;
}

/** Rankings watch and site health for the Autopilot page. */
export const autopilotWatch = (req: Request) =>
  withAccount(req, async (account) => {
    const conn = await getConnection(account.id);
    const [ranks, health, claims, overlap] = await Promise.all([
      rankWatch(account.id),
      healthReport(account.id, conn),
      claimReport(account.id),
      overlapReport(account.id),
    ]);
    return json({ ranks, health, claims, overlap, roles: await keywordRoles(account.id) });
  });

/** Which tracked searches are long tail main targets and which are broad support. */
async function keywordRoles(accountId: string): Promise<Record<string, "main" | "support">> {
  const [kws, targets] = await Promise.all([readSiteKeywords(accountId).catch(() => []), readTargets(accountId).catch(() => [])]);
  const roles: Record<string, "main" | "support"> = {};
  for (const k of kws) roles[k.keyword] = k.role ?? "main";
  for (const t of targets) roles[t.keyword] = t.role ?? "main";
  return roles;
}

/** "Check now": today's ranks (if not done yet) and the next pages' health. */
export const autopilotCheckNow = (req: Request) =>
  withAccount(req, async (account) => {
    await maintain(account.id, true);
    const conn = await getConnection(account.id);
    const [ranks, health, claims, overlap] = await Promise.all([
      rankWatch(account.id),
      healthReport(account.id, conn),
      claimReport(account.id),
      overlapReport(account.id),
    ]);
    return json({ ranks, health, claims, overlap });
  });

/** Goes through a whole run on live data and returns what it would change, without changing anything. */
export const previewAutopilot = (req: Request) =>
  withAccount(req, async (account) => json(await runAutopilot(account.id, await getConnection(account.id), "preview")));

export const runAutopilotNow = (req: Request) =>
  withAccount(req, async (account) => json(await runAutopilot(account.id, await getConnection(account.id), "manual")));

/** Fix list: the owner pasted a change in, or skipped it. */
export const markFix = (req: Request) =>
  withAccount(req, async (account) => {
    const b = await req.json().catch(() => ({}));
    try {
      await markSuggestion(account.id, String(b.id ?? ""), b.done !== false);
      return json(await autopilotHistory(account.id));
    } catch (err) {
      return json({ error: message(err) }, 400);
    }
  });

export const revertAutopilot = (req: Request) =>
  withAccount(req, async (account) => {
    const b = await req.json().catch(() => ({}));
    try {
      await revertChange(account.id, String(b.id ?? ""));
      return json(await autopilotHistory(account.id));
    } catch (err) {
      return json({ error: message(err) }, 400);
    }
  });

/** Called by the scheduled trigger: runs a few customers whose daily run is due. */
export async function autopilotTick(): Promise<Response> {
  const results: string[] = [];
  try {
    // Rank checks and health first: a drop found this morning can be defended in today's run.
    const upkeep = [...new Set([...(await accountsDueForTracking(3)), ...(await accountsDueForHealth(3))])].slice(0, 3);
    for (const accountId of upkeep) {
      results.push(`account ${accountId} checks: ${await maintain(accountId).catch((e) => message(e))}`);
    }
    for (const accountId of await accountsDueForRun(3)) {
      const r = await runAutopilot(accountId, await getConnection(accountId), "schedule").catch((e) => ({ message: message(e) }));
      results.push(`account ${accountId}: ${r.message}`);
    }
    console.log(`autopilot tick: ${results.join(" | ") || "nothing due"}`);
    return json({ results });
  } catch (err) {
    console.error(`autopilot tick failed: ${message(err)}`);
    return json({ error: message(err) }, 500);
  }
}

// ---------- Shopify connection ----------

/** "Connect Shopify": sends the customer to their store to approve the app. */
export async function shopifyInstall(req: Request): Promise<Response> {
  const account = await currentAccount(req);
  if (!account) return redirect(`${appOrigin(req)}/analytics`);
  const shop = normalizeShopDomain(new URL(req.url).searchParams.get("shop") ?? "");
  if (!shop) return redirect(`${appOrigin(req)}/analytics?shopify_error=Enter+your+store+name,+like+mystore.myshopify.com#autopilot`);
  try {
    const state = crypto.randomBytes(16).toString("hex");
    return redirect(await authorizeUrl(shop, shopifyRedirectUri(req), state), tempCookie(req, SHOPIFY_STATE_COOKIE, state, 600));
  } catch (err) {
    return redirect(`${appOrigin(req)}/analytics?${new URLSearchParams({ shopify_error: message(err) })}#autopilot`);
  }
}

export async function shopifyCallback(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const back = (p: Record<string, string>) =>
    redirect(`${appOrigin(req)}/analytics?${new URLSearchParams(p)}#autopilot`, tempCookie(req, SHOPIFY_STATE_COOKIE, "", 0));
  const account = await currentAccount(req);
  if (!account) return back({ shopify_error: "Please sign in, then connect your store again." });
  const shop = normalizeShopDomain(params.get("shop") ?? "");
  const code = params.get("code");
  if (!shop || !code || params.get("state") !== readCookie(req, SHOPIFY_STATE_COOKIE) || !(await verifyCallbackHmac(params))) {
    return back({ shopify_error: "The connection link expired or was invalid. Please try again." });
  }
  try {
    await completeInstall(account.id, shop, code);
    // The store's domain is known now: find its Search Console and Analytics properties.
    await autoMatch(account.id).catch(() => undefined);
    const name = await shopName({ accountId: account.id, shopDomain: shop }).catch(() => shop);
    return back({ shopify: name });
  } catch (err) {
    return back({ shopify_error: message(err) });
  }
}

export const shopifyDisconnect = (req: Request) =>
  withAccount(req, async (account) => {
    await saveAccountAutopilot(account.id, { shopDomain: "", shopTokenEnc: null, enabled: false });
    return json({ settings: await autopilotView(account.id, account.admin) });
  });

/** Shopify's app and privacy webhooks (app/uninstalled, shop/redact, customers/*). */
export async function shopifyWebhook(req: Request): Promise<Response> {
  const raw = await req.text();
  if (!(await verifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256")).catch(() => false))) {
    return new Response("Invalid signature", { status: 401 });
  }
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shop = req.headers.get("x-shopify-shop-domain") ?? "";
  if (topic === "app/uninstalled" || topic === "shop/redact") {
    await ensureSchema();
    // We keep no customer data from stores; forgetting the store connection is all there is to erase.
    await sql`UPDATE insights_account_autopilot SET shop_domain = NULL, shop_token_enc = NULL, enabled = false WHERE shop_domain = ${shop}`;
  }
  return new Response(null, { status: 200 });
}
