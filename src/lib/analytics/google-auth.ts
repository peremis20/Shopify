import crypto from "crypto";

/**
 * Minimal Google service account auth: signs a JWT and trades it for an
 * access token. Avoids pulling in the full googleapis SDK for two APIs.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

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

let cached: { token: string; expiresAt: number } | null = null;

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64url");

async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

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
  const assertion = `${header}.${claims}.${b64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Google sign in failed: ${body.error_description ?? body.error ?? res.status}`);
  }

  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

/** POSTs JSON to a Google API and surfaces Google's own error message on failure. */
export async function googlePost<T>(url: string, payload: unknown): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `Request failed with status ${res.status}`);
  }
  return body as T;
}
