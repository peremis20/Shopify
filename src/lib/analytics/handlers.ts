import crypto from "crypto";
import { deleteConnection, getConnection, saveConnection, signInAvailable, STATE_COOKIE } from "./connection";
import { isRangeKey } from "./dates";
import { exchangeAuthCode, OAUTH_SCOPES, revokeToken } from "./google-auth";
import { getOAuthClient, saveOAuthClient } from "./oauth-client";
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

    // Start with the first property of each kind so data shows up right away.
    const options = await listProperties({ kind: "oauth", refreshToken });
    await saveConnection({
      refreshToken,
      email,
      gaPropertyId: options.ga.items[0]?.id,
      gscSiteUrl: options.gsc.items[0],
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
