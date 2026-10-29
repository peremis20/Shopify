import crypto from "crypto";
import { currentAccount, readCookie, sessionCookie, upsertAccount, type Account } from "./accounts";
import { accountsDueForRun, autopilotHistory, logChange, revertChange, runAutopilot } from "./autopilot/engine";
import { claimReport, claimScanDue, scanStoreClaims } from "./autopilot/claim-scan";
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
import { ADS_OAUTH_SCOPES, exchangeAuthCode, OAUTH_SCOPES, revokeToken } from "./google-auth";
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
import { getOverview } from "./overview";
import { listProperties } from "./properties";
import { addKeywords, createList, deleteList, findOpportunities, getLists, removeKeyword, trackRankings } from "./seo-tools";

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
async function withAccount(req: Request, run: (account: Account) => Promise<Response>): Promise<Response> {
  const account = await currentAccount(req);
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
  const account = await currentAccount(req).catch(() => null);
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
  const purpose = new URL(req.url).searchParams.get("purpose") === "ads" ? "ads" : "signin";
  if (purpose === "ads" && !(await currentAccount(req))?.admin) {
    return redirect(`${appOrigin(req)}/analytics?auth_error=Only+the+platform+owner+can+connect+Google+Ads`);
  }
  const state = `${purpose}.${crypto.randomBytes(16).toString("hex")}`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: (purpose === "ads" ? ADS_OAUTH_SCOPES : OAUTH_SCOPES).join(" "),
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

    const account = await upsertAccount(email);
    // Keep the properties already chosen when a customer signs in again.
    const previous = await getConnection(account.id).catch(() => null);
    const options = previous?.gaPropertyId && previous.gscSiteUrl
      ? null
      : await listProperties({ kind: "oauth", refreshToken });
    await saveConnection(account.id, {
      refreshToken,
      email,
      gaPropertyId: previous?.gaPropertyId || options?.ga.items[0]?.id,
      gscSiteUrl: previous?.gscSiteUrl || options?.gsc.items[0],
    });
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
      params.get("refresh") === "1"
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
      return json({ opportunities: await findOpportunities(conn, isRangeKey(range) ? range : "28d") });
    } catch (err) {
      return json({ error: message(err) }, 502);
    }
  });

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
  if (!acct.shopDomain || !acct.shopTokenEnc || !(force || (await claimScanDue(accountId)))) return 0;
  return scanStoreClaims(accountId, { accountId, shopDomain: acct.shopDomain });
}

/** Weekly overlap check: duplicate titles and descriptions, near duplicate posts, pages competing for a search. */
async function runOverlapScan(accountId: string, conn: Connection | null, force: boolean): Promise<number> {
  const acct = await readAccountAutopilot(accountId);
  if (!acct.shopDomain || !acct.shopTokenEnc || !(force || (await overlapScanDue(accountId)))) return 0;
  const brand = conn?.gscSiteUrl ? domainOf(conn.gscSiteUrl).split(".")[0] : "";
  return scanOverlap(accountId, { accountId, shopDomain: acct.shopDomain }, conn, brand);
}

/** Today's rank check, a few page health checks, and the weekly link fix, claim and overlap checks for one account. Each part runs at most once a day. */
async function maintain(accountId: string, force = false): Promise<string> {
  const [conn, platform] = await Promise.all([getConnection(accountId), readPlatformSettings()]);
  const links = await fixLinks(accountId, force).catch((e) => (console.error(`link fix failed: ${message(e)}`), 0));
  const claims = await runClaimScan(accountId, force).catch((e) => (console.error(`claim scan failed: ${message(e)}`), 0));
  const overlaps = await runOverlapScan(accountId, conn, force).catch((e) => (console.error(`overlap scan failed: ${message(e)}`), 0));
  if (!conn?.gscSiteUrl) return `no Search Console property, links ${links}, claims ${claims}, overlaps ${overlaps}`;
  const ranks = platform.serperKey ? await trackRanks(accountId, conn, platform.serperKey, domainOf(conn.gscSiteUrl)).catch(() => 0) : 0;
  const pages = await checkHealth(accountId, conn, platform.pagespeedKey, force ? 8 : undefined).catch(() => 0);
  return `ranks ${ranks}, health ${pages}, links ${links}, claims ${claims}, overlaps ${overlaps}`;
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
    return json({ ranks, health, claims, overlap });
  });

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
