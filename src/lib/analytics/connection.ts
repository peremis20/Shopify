import crypto from "crypto";
import { db, ensureSchema, hasDatabase } from "./db";
import { oauthClient } from "./google-auth";

/**
 * The connected Google account is stored in Neon, so it works from any
 * device and survives cleared cookies. The dashboard has one owner, so
 * there is a single row. The refresh token is encrypted before it is saved.
 */

export interface Connection {
  refreshToken: string;
  email?: string;
  gaPropertyId?: string;
  gscSiteUrl?: string;
}

export const STATE_COOKIE = "insights_oauth_state";
const ROW_ID = "default";

/** Sign in needs both an OAuth client and a database to keep the connection in. */
export const signInAvailable = () => Boolean(oauthClient()) && hasDatabase();

function key(): Buffer {
  const secret = process.env.SESSION_SECRET || oauthClient()?.secret;
  if (!secret) throw new Error("Google sign in is not set up on the server.");
  return crypto.createHash("sha256").update(`insights:${secret}`).digest();
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

function decrypt(value: string): string | null {
  try {
    const raw = Buffer.from(value, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null; // the secret changed, so the saved token can't be used
  }
}

export async function getConnection(): Promise<Connection | null> {
  if (!signInAvailable()) return null;
  await ensureSchema();
  const [row] = await db()`
    SELECT refresh_token_enc, email, ga_property_id, gsc_site_url
    FROM insights_google_connection WHERE id = ${ROW_ID}`;
  if (!row) return null;
  const refreshToken = decrypt(row.refresh_token_enc);
  if (!refreshToken) return null;
  return {
    refreshToken,
    email: row.email ?? undefined,
    gaPropertyId: row.ga_property_id ?? undefined,
    gscSiteUrl: row.gsc_site_url ?? undefined,
  };
}

export async function saveConnection(c: Connection): Promise<void> {
  await ensureSchema();
  await db()`
    INSERT INTO insights_google_connection (id, refresh_token_enc, email, ga_property_id, gsc_site_url)
    VALUES (${ROW_ID}, ${encrypt(c.refreshToken)}, ${c.email ?? null}, ${c.gaPropertyId ?? null}, ${c.gscSiteUrl ?? null})
    ON CONFLICT (id) DO UPDATE SET
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      email = EXCLUDED.email,
      ga_property_id = EXCLUDED.ga_property_id,
      gsc_site_url = EXCLUDED.gsc_site_url,
      updated_at = now()`;
}

export async function deleteConnection(): Promise<void> {
  await ensureSchema();
  await db()`DELETE FROM insights_google_connection WHERE id = ${ROW_ID}`;
  await db()`DELETE FROM insights_report_cache`;
}

/** Where Google sends the user back to. Set APP_URL if the app sits behind a proxy that hides its address. */
export function redirectUri(requestOrigin: string): string {
  const base = process.env.APP_URL?.replace(/\/$/, "") || requestOrigin;
  return `${base}/api/auth/google/callback`;
}
