import { ensureSchema, hasDatabase, sql } from "./db";
import { getOAuthClient, tokenSecret } from "./oauth-client";
import { decrypt, encrypt } from "./secrets";

/**
 * Each account's Google connection (Analytics + Search Console), stored in
 * Neon with the refresh token encrypted.
 */

export interface Connection {
  refreshToken: string;
  email?: string;
  gaPropertyId?: string;
  gscSiteUrl?: string;
}

export const STATE_COOKIE = "insights_oauth_state";

/** Sign in needs both an OAuth client and a database. */
export const signInAvailable = async () => hasDatabase() && Boolean(await getOAuthClient());

export async function getConnection(accountId: string | null | undefined): Promise<Connection | null> {
  if (!accountId || !(await signInAvailable())) return null;
  await ensureSchema();
  const [row] = await sql`
    SELECT refresh_token_enc, email, ga_property_id, gsc_site_url
    FROM insights_account_google WHERE account_id = ${accountId}`;
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

export async function saveConnection(accountId: string, c: Connection): Promise<void> {
  await ensureSchema();
  const enc = encrypt(c.refreshToken, await tokenSecret());
  await sql`
    INSERT INTO insights_account_google (account_id, refresh_token_enc, email, ga_property_id, gsc_site_url)
    VALUES (${accountId}, ${enc}, ${c.email ?? null}, ${c.gaPropertyId ?? null}, ${c.gscSiteUrl ?? null})
    ON CONFLICT (account_id) DO UPDATE SET
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      email = EXCLUDED.email,
      ga_property_id = EXCLUDED.ga_property_id,
      gsc_site_url = EXCLUDED.gsc_site_url,
      updated_at = now()`;
}

export async function deleteConnection(accountId: string): Promise<void> {
  await ensureSchema();
  await sql`DELETE FROM insights_account_google WHERE account_id = ${accountId}`;
  await sql`DELETE FROM insights_report_cache WHERE cache_key LIKE ${`${accountId}|%`}`;
}
