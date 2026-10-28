import { ensureSchema, hasDatabase, sql } from "./db";
import { getOAuthClient, tokenSecret } from "./oauth-client";
import { decrypt, encrypt } from "./secrets";

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
export const signInAvailable = async () => hasDatabase() && Boolean(await getOAuthClient());

export async function getConnection(): Promise<Connection | null> {
  if (!(await signInAvailable())) return null;
  await ensureSchema();
  const [row] = await sql`
    SELECT refresh_token_enc, email, ga_property_id, gsc_site_url
    FROM insights_google_connection WHERE id = ${ROW_ID}`;
  if (!row?.refresh_token_enc) return null;
  const refreshToken = decrypt(row.refresh_token_enc, await tokenSecret());
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
  const enc = encrypt(c.refreshToken, await tokenSecret());
  await sql`
    INSERT INTO insights_google_connection (id, refresh_token_enc, email, ga_property_id, gsc_site_url)
    VALUES (${ROW_ID}, ${enc}, ${c.email ?? null}, ${c.gaPropertyId ?? null}, ${c.gscSiteUrl ?? null})
    ON CONFLICT (id) DO UPDATE SET
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      email = EXCLUDED.email,
      ga_property_id = EXCLUDED.ga_property_id,
      gsc_site_url = EXCLUDED.gsc_site_url,
      updated_at = now()`;
}

export async function deleteConnection(): Promise<void> {
  await ensureSchema();
  await sql`DELETE FROM insights_google_connection WHERE id = ${ROW_ID}`;
  await sql`DELETE FROM insights_report_cache`;
}
