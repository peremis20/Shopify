import crypto from "crypto";
import { deleteConnection, getConnection, saveConnection, signInAvailable, STATE_COOKIE } from "./connection";
import { isRangeKey } from "./dates";
import { exchangeAuthCode, OAUTH_SCOPES, revokeToken } from "./google-auth";
import { KEYWORD_LANGUAGES, KEYWORD_LOCATIONS } from "./keyword-options";
import { explainAdsError, keywordIdeas, keywordStatus, keywordVolumes, saveAdsSettings, type KeywordQuery } from "./keywords";
import { getOAuthClient, saveOAuthClient } from "./oauth-client";
import { autopilotHistory, revertChange, runAutopilot } from "./autopilot/engine";
import { readAutopilotSettings, saveAutopilotSettings, viewOf } from "./autopilot/settings";
import { shopName } from "./autopilot/shopify";
import { checkAnthropicKey } from "./autopilot/writer";
import { addKeywords, createList, deleteList, findOpportunities, getLists, removeKeyword, trackRankings } from "./seo-tools";
import { getOverview } from "./overview";
import { listProperties } from "./properties";

/**
 * Every API route of the dashboard as a plain web handler (Request in,
 * Response out), shared by the Next.js routes and the Neon Function.
 */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

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

function readCookie(req: Request, name: string): string | undefined {
  const match = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function stateCookie(req: Request, value: string, maxAge: number): string {
  const secure = appOrigin(req).startsWith("https:") ? "; Secure" : "";
  return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export async function overview(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const range = params.get("range");
  try {
    const data = await getOverview(
      isRangeKey(range) ? range : "28d",
      await getConnection(),
      redirectUri(req),
      params.get("refresh") === "1"
    );
    return json(data);
  } catch (err) {
    return json({ error: `Couldn't reach the database: ${message(err)}` }, 500);
  }
}

export async function properties(): Promise<Response> {
  const conn = await getConnection();
  if (!conn) return json({ error: "Connect your Google account first." }, 401);
  return json(await listProperties({ kind: "oauth", refreshToken: conn.refreshToken }));
}

/** Saves which GA4 property and Search Console site the dashboard reads. */
export async function saveSettings(req: Request): Promise<Response> {
  const conn = await getConnection();
  if (!conn) return json({ error: "Connect your Google account first." }, 401);

  const body = await req.json().catch(() => ({}));
  const gaPropertyId = typeof body.gaPropertyId === "string" ? body.gaPropertyId.trim() : "";
  const gscSiteUrl = typeof body.gscSiteUrl === "string" ? body.gscSiteUrl.trim() : "";
  if (gaPropertyId && !/^\d+$/.test(gaPropertyId)) {
    return json({ error: "That Google Analytics property ID doesn't look right." }, 400);
  }

  await saveConnection({ ...conn, gaPropertyId: gaPropertyId || undefined, gscSiteUrl: gscSiteUrl || undefined });
  return json({ ok: true });
}

/** Saves the Google Client ID and secret entered in Settings. */
export async function saveGoogleClient(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  // Pull the ID out of whatever was pasted, since copying from Google Cloud
  // can bring the field's label or spaces along with it.
  const id = typeof body.clientId === "string"
    ? body.clientId.match(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/)?.[0] ?? ""
    : "";
  const secret = typeof body.clientSecret === "string"
    ? body.clientSecret.replace(/^[\s\S]*?(GOCSPX-)/, "$1").replace(/\s+/g, "")
    : "";
  if (!id) {
    return json({ error: "That doesn't look like a Client ID. It ends with .apps.googleusercontent.com" }, 400);
  }
  if (secret.length < 10) {
    return json({ error: "Paste the full Client secret from Google Cloud." }, 400);
  }
  try {
    await saveOAuthClient({ id, secret });
    return json({ ok: true });
  } catch (err) {
    return json({ error: message(err) }, 400);
  }
}

/** Sends the user to Google's consent screen. */
export async function authStart(req: Request): Promise<Response> {
  const client = await getOAuthClient();
  if (!client || !(await signInAvailable())) {
    return redirect(`${appOrigin(req)}/analytics?auth_error=Google+sign+in+is+not+set+up+yet`);
  }

  const state = crypto.randomBytes(16).toString("hex");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return redirect(url.toString(), stateCookie(req, state, 600));
}

/** Google redirects here after consent. Saves the connection and picks a starting property. */
export async function authCallback(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const back = (p: Record<string, string>) =>
    redirect(`${appOrigin(req)}/analytics?${new URLSearchParams(p)}`, stateCookie(req, "", 0));

  const error = params.get("error");
  if (error) return back({ auth_error: error === "access_denied" ? "Google access was not granted" : error });

  const state = params.get("state");
  const code = params.get("code");
  if (!code || !state || state !== readCookie(req, STATE_COOKIE)) {
    return back({ auth_error: "The sign in link expired. Please try again." });
  }

  try {
    const { refreshToken, email } = await exchangeAuthCode(code, redirectUri(req));
    if (!refreshToken) throw new Error("Google did not return offline access. Please try again.");

    // Keep the properties already chosen when the same account reconnects;
    // otherwise start with the first of each kind so data shows up right away.
    const previous = await getConnection().catch(() => null);
    const same = previous && previous.email === email;
    const options = same && previous.gaPropertyId && previous.gscSiteUrl
      ? null
      : await listProperties({ kind: "oauth", refreshToken });
    await saveConnection({
      refreshToken,
      email,
      gaPropertyId: (same && previous.gaPropertyId) || options?.ga.items[0]?.id,
      gscSiteUrl: (same && previous.gscSiteUrl) || options?.gsc.items[0],
    });
    return back({ connected: "1" });
  } catch (err) {
    return back({ auth_error: message(err) });
  }
}

export async function disconnect(): Promise<Response> {
  const conn = await getConnection();
  if (conn) await revokeToken(conn.refreshToken);
  await deleteConnection();
  return json({ ok: true });
}

/** Where Keyword Planner setup stands, and the Ads accounts to choose from. */
export async function keywordSetup(): Promise<Response> {
  try {
    return json(await keywordStatus(await getConnection()));
  } catch (err) {
    return json({ step: "token", error: explainAdsError(err) });
  }
}

/** Saves the Google Ads developer token, account ID or manager account ID. */
export async function saveKeywordSettings(req: Request): Promise<Response> {
  if (!(await getConnection())) return json({ error: "Connect your Google account first." }, 401);
  const body = await req.json().catch(() => ({}));
  const pick = (k: string) => (typeof body[k] === "string" ? body[k] : undefined);
  const developerToken = pick("developerToken")?.replace(/\s+/g, "");
  if (developerToken !== undefined && developerToken.length < 15) {
    return json({ error: "Paste the full developer token from Google Ads (Admin, then API Center)." }, 400);
  }
  await saveAdsSettings({
    developerToken,
    customerId: pick("customerId"),
    loginCustomerId: pick("loginCustomerId"),
  });
  return json({ ok: true });
}

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

/** Keyword ideas for seed keywords and/or a website. */
export async function keywordIdeasHandler(req: Request): Promise<Response> {
  const conn = await getConnection();
  if (!conn) return json({ error: "Connect your Google account first." }, 401);
  const q = readKeywordQuery(await req.json().catch(() => ({})));
  if (!q.keywords.length && !q.url) return json({ error: "Enter a keyword or a website address." }, 400);
  try {
    return json({ ideas: await keywordIdeas(conn, q) });
  } catch (err) {
    return json({ error: explainAdsError(err) }, 502);
  }
}

/** Search volume for an exact list of keywords, such as your Search Console queries. */
export async function keywordVolumesHandler(req: Request): Promise<Response> {
  const conn = await getConnection();
  if (!conn) return json({ error: "Connect your Google account first." }, 401);
  const q = readKeywordQuery(await req.json().catch(() => ({})));
  if (!q.keywords.length) return json({ error: "There are no keywords to look up yet." }, 400);
  try {
    return json({ ideas: await keywordVolumes(conn, q) });
  } catch (err) {
    return json({ error: explainAdsError(err) }, 502);
  }
}

const needConnection = () => json({ error: "Connect your Google account first." }, 401);

/** Searches ranking just outside Google's top results, sorted by upside. */
export async function opportunities(req: Request): Promise<Response> {
  const conn = await getConnection();
  if (!conn) return needConnection();
  const range = new URL(req.url).searchParams.get("range");
  try {
    return json({ opportunities: await findOpportunities(conn, isRangeKey(range) ? range : "28d") });
  } catch (err) {
    return json({ error: message(err) }, 502);
  }
}

export async function keywordLists(): Promise<Response> {
  if (!(await getConnection())) return needConnection();
  return json({ lists: await getLists() });
}

/** One endpoint for list changes: create, delete, add keywords, remove a keyword. */
export async function updateKeywordLists(req: Request): Promise<Response> {
  if (!(await getConnection())) return needConnection();
  const body = await req.json().catch(() => ({}));
  const str = (k: string) => (typeof body[k] === "string" ? body[k].trim() : "");
  switch (body.action) {
    case "create": {
      const name = str("name").slice(0, 80);
      if (!name) return json({ error: "Give the list a name." }, 400);
      const list = await createList(name);
      if (Array.isArray(body.keywords)) await addKeywords(list.id, body.keywords.map(String));
      break;
    }
    case "delete":
      await deleteList(str("listId"));
      break;
    case "add":
      if (!Array.isArray(body.keywords)) return json({ error: "No keywords to add." }, 400);
      await addKeywords(str("listId"), body.keywords.map(String));
      break;
    case "remove":
      await removeKeyword(str("listId"), str("keyword"));
      break;
    default:
      return json({ error: "Unknown action." }, 400);
  }
  return json({ lists: await getLists() });
}

/** Weekly Google positions for the keywords in a saved list. */
export async function rankings(req: Request): Promise<Response> {
  const conn = await getConnection();
  if (!conn) return needConnection();
  const listId = new URL(req.url).searchParams.get("listId");
  const list = (await getLists()).find((l) => l.id === listId);
  if (!list) return json({ error: "That list doesn't exist anymore." }, 404);
  try {
    return json({ rankings: await trackRankings(conn, list.keywords) });
  } catch (err) {
    return json({ error: message(err) }, 502);
  }
}

// ---------- autopilot ----------

export async function autopilotStatus(): Promise<Response> {
  if (!(await getConnection())) return needConnection();
  return json({ settings: viewOf(await readAutopilotSettings()), ...(await autopilotHistory()) });
}

export async function saveAutopilot(req: Request): Promise<Response> {
  if (!(await getConnection())) return needConnection();
  const b = await req.json().catch(() => ({}));
  const str = (k: string) => (typeof b[k] === "string" ? b[k] : undefined);
  await saveAutopilotSettings({
    enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
    maxPagesPerWeek: typeof b.maxPagesPerWeek === "number" ? b.maxPagesPerWeek : undefined,
    allowContent: typeof b.allowContent === "boolean" ? b.allowContent : undefined,
    shopDomain: str("shopDomain"),
    shopifyClientId: str("shopifyClientId"),
    shopifyClientSecret: str("shopifyClientSecret"),
    anthropicKey: str("anthropicKey"),
  });
  return json({ settings: viewOf(await readAutopilotSettings()) });
}

/** Checks the Shopify app and Claude key without changing anything. */
export async function testAutopilot(): Promise<Response> {
  if (!(await getConnection())) return needConnection();
  const s = await readAutopilotSettings();
  const result: { shopify?: string; claude?: string; shopifyError?: string; claudeError?: string } = {};
  await Promise.all([
    shopName(s).then((n) => (result.shopify = n)).catch((e) => (result.shopifyError = message(e))),
    s.anthropicKey
      ? checkAnthropicKey(s.anthropicKey).then(() => (result.claude = "ok")).catch((e) => (result.claudeError = message(e)))
      : Promise.resolve((result.claudeError = "Add your Claude API key.")),
  ]);
  return json(result);
}

export async function runAutopilotNow(): Promise<Response> {
  const conn = await getConnection();
  if (!conn) return needConnection();
  try {
    return json(await runAutopilot(conn, "manual"));
  } catch (err) {
    return json({ error: message(err) }, 500);
  }
}

/** Called by the daily scheduled trigger. */
export async function autopilotTick(): Promise<Response> {
  try {
    const result = await runAutopilot(await getConnection(), "schedule");
    console.log(`autopilot: ${result.message}`);
    return json(result);
  } catch (err) {
    console.error(`autopilot failed: ${message(err)}`);
    return json({ error: message(err) }, 500);
  }
}

export async function revertAutopilot(req: Request): Promise<Response> {
  if (!(await getConnection())) return needConnection();
  const b = await req.json().catch(() => ({}));
  try {
    await revertChange(String(b.id ?? ""));
    return json(await autopilotHistory());
  } catch (err) {
    return json({ error: message(err) }, 400);
  }
}
