import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/** Neon Postgres, reached over HTTP so it works in serverless functions. */

let client: NeonQueryFunction<false, false> | null = null;
let schemaReady: Promise<void> | null = null;

export const hasDatabase = () => Boolean(process.env.DATABASE_URL);

export function db(): NeonQueryFunction<false, false> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  client ??= neon(process.env.DATABASE_URL);
  return client;
}

/** Creates the dashboard's tables on first use (same as db/insights-schema.sql). */
export function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const sql = db();
    await sql`CREATE TABLE IF NOT EXISTS insights_google_connection (
      id text PRIMARY KEY DEFAULT 'default',
      refresh_token_enc text NOT NULL,
      email text,
      ga_property_id text,
      gsc_site_url text,
      connected_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_report_cache (
      cache_key text PRIMARY KEY,
      data jsonb NOT NULL,
      fetched_at timestamptz NOT NULL DEFAULT now()
    )`;
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}
