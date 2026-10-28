import crypto from "crypto";
import { getOAuthClient } from "./oauth-client";

/**
 * Minimal Google auth for two ways of connecting: "Sign in with Google"
 * (OAuth refresh token) or a service account (signed JWT). Avoids pulling in
 * the full googleapis SDK for a handful of read only calls.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];
/** Keyword Planner data comes through the Google Ads API. */
export const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
/** Sign in also asks for the email address, to show which account is connected. */
export const OAUTH_SCOPES = ["openid", "email", ...SCOPES, ADS_SCOPE];

interface ServiceAccount {
  email: string;
  privateKey: string;
}

/**
 * Reads credentials from either GOOGLE_SERVICE_ACCOUNT_JSON (the whole key
 * file, raw or base64) or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY.
 */
export function getServiceAccount(): ServiceAccount | null {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (json) {
    try {
      const raw = json.startsWith("{") ? json : Buffer.from(json, "base64").toString("utf8");
      const parsed = JSON.parse(raw);
      if (parsed.client_email && parsed.private_key) {
        return { email: parsed.client_email, privateKey: parsed.private_key };
      }
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON.");
    }
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (email && key) {
    return { email, privateKey: key.replace(/\\n/g, "\n") };
  }
  return null;
}

export type GoogleAuth =
  | { kind: "service_account" }
  | { kind: "oauth"; refreshToken: string };

const tokenCache = new Map<string, { token: string; expiresAt: number; scope: string }>();

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64url");

async function requestToken(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    cache: "no-store",
  });
  const body = await res.json();
  if (!res.ok) {
    if (body.error === "invalid_grant" && params.grant_type === "refresh_token") {
      throw new Error("Google access has expired or was removed. Reconnect your Google account in Settings.");
    }
    throw new Error(`Google sign in failed: ${body.error_description ?? body.error ?? res.status}`);
  }
  return body as {
    access_token: string;
    expires_in: number;
    scope?: string;
    refresh_token?: string;
    id_token?: string;
  };
}

function serviceAccountAssertion(): string {
  const account = getServiceAccount();
  if (!account) throw new Error("Google service account credentials are not set.");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: account.email,
      scope: SCOPES.join(" "),
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(account.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

async function getToken(auth: GoogleAuth): Promise<{ token: string; scope: string }> {
  const key =
    auth.kind === "oauth"
      ? crypto.createHash("sha256").update(auth.refreshToken).digest("hex")
      : "service_account";
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit;

  let body;
  if (auth.kind === "oauth") {
    const client = await getOAuthClient();
    if (!client) throw new Error("Google sign in is not set up on the server.");
    body = await requestToken({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: client.id,
      client_secret: client.secret,
    });
  } else {
    body = await requestToken({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountAssertion(),
    });
  }

  const entry = {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope ?? SCOPES.join(" "),
  };
  tokenCache.set(key, entry);
  return entry;
}

/** Whether the connected account granted a scope (older connections predate Google Ads access). */
export async function hasScope(auth: GoogleAuth, scope: string): Promise<boolean> {
  return (await getToken(auth)).scope.split(" ").includes(scope);
}

/** Trades the one time code from Google's consent screen for long lived access. */
export async function exchangeAuthCode(code: string, redirectUri: string) {
  const client = await getOAuthClient();
  if (!client) throw new Error("Google sign in is not set up on the server.");
  const body = await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.id,
    client_secret: client.secret,
  });
  let email: string | undefined;
  if (body.id_token) {
    try {
      email = JSON.parse(Buffer.from(body.id_token.split(".")[1], "base64url").toString()).email;
    } catch {
      /* email is only used for display */
    }
  }
  return { refreshToken: body.refresh_token, email };
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: "POST",
  }).catch(() => undefined);
}

/** A failed Google API call, keeping Google's structured error details. */
export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number, readonly details: unknown[]) {
    super(message);
  }
}

/**
 * Calls a Google API (POST with a JSON body, or GET without one) and
 * surfaces Google's own error message on failure.
 */
export async function googleRequest<T>(
  auth: GoogleAuth,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<T> {
  const { token } = await getToken(auth);
  const res = await fetch(url, {
    method: payload === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GoogleApiError(
      body?.error?.message ?? `Request failed with status ${res.status}`,
      res.status,
      body?.error?.details ?? []
    );
  }
  return body as T;
}
