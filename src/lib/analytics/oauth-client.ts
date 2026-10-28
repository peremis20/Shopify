import { ensureSchema, hasDatabase, sql } from "./db";
import { decrypt, encrypt } from "./secrets";

/**
 * The Google OAuth client (Client ID + secret) comes from environment
 * variables, or, when those aren't set, from the Settings screen, which
 * stores it in Neon with the secret encrypted by SESSION_SECRET.
 */

export interface OAuthClient {
  id: string;
  secret: string;
}

const SETTING_KEY = "google_oauth_client";

function envClient(): OAuthClient | null {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return id && secret ? { id, secret } : null;
}

/** Whether the Client ID and secret can be entered from the dashboard. */
export const canSaveClient = () =>
  !envClient() && hasDatabase() && Boolean(process.env.SESSION_SECRET);

let cached: { at: number; client: OAuthClient | null } | null = null;

export async function getOAuthClient(): Promise<OAuthClient | null> {
  const fromEnv = envClient();
  if (fromEnv) return fromEnv;
  if (!canSaveClient()) return null;
  if (cached && Date.now() - cached.at < 60_000) return cached.client;

  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${SETTING_KEY}`;
  let client: OAuthClient | null = null;
  const json = row?.value ? decrypt(row.value, process.env.SESSION_SECRET!) : null;
  if (json) {
    const parsed = JSON.parse(json);
    if (parsed.id && parsed.secret) client = { id: parsed.id, secret: parsed.secret };
  }
  cached = { at: Date.now(), client };
  return client;
}

export async function saveOAuthClient(client: OAuthClient): Promise<void> {
  if (!canSaveClient()) throw new Error("Google credentials can't be saved from here on this server.");
  await ensureSchema();
  const value = encrypt(JSON.stringify(client), process.env.SESSION_SECRET!);
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${SETTING_KEY}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  cached = null;
}

/** The key that encrypts stored Google tokens. */
export async function tokenSecret(): Promise<string> {
  const secret = process.env.SESSION_SECRET || (await getOAuthClient())?.secret;
  if (!secret) throw new Error("Google sign in is not set up on the server.");
  return secret;
}
