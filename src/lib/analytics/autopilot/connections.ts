import { ensureSchema, sql } from "../db";
import { tokenSecret } from "../oauth-client";
import { decrypt, encrypt } from "../secrets";

/** A website platform connection (Webflow site token, Wix API key...), stored encrypted per account. */
export type ConnectionKind = "webflow" | "wix";

const key = (kind: ConnectionKind, accountId: string) => `${kind}:${accountId}`;

export async function readConnection<T>(kind: ConnectionKind, accountId: string): Promise<T | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${key(kind, accountId)}`;
  const json = row?.value ? decrypt(row.value, await tokenSecret()) : null;
  return json ? (JSON.parse(json) as T) : null;
}

export async function saveConnectionFor(kind: ConnectionKind, accountId: string, value: object): Promise<void> {
  const enc = encrypt(JSON.stringify(value), await tokenSecret());
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${key(kind, accountId)}, ${enc})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export async function deleteConnectionFor(kind: ConnectionKind, accountId: string): Promise<void> {
  await sql`DELETE FROM insights_settings WHERE key = ${key(kind, accountId)}`;
}
