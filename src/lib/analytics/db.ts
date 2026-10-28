/**
 * Minimal Neon Postgres client over Neon's HTTP query endpoint. Plain fetch,
 * no driver, so the same code runs in Next.js and in a Neon Function.
 * Values come back as text (jsonb as a JSON string).
 */

export type Row = Record<string, string | null>;

let schemaReady: Promise<void> | null = null;

export const hasDatabase = () => Boolean(process.env.DATABASE_URL);

export async function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const query = strings.reduce((q, part, i) => q + part + (i < values.length ? `$${i + 1}` : ""), "");
  const params = values.map((v) => (v === null || v === undefined ? null : String(v)));

  // Same endpoint the Neon serverless driver uses: the host's first label becomes "api".
  const host = new URL(url).hostname.replace(/^[^.]+\./, "api.");
  const res = await fetch(`https://${host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": url,
      "Neon-Raw-Text-Output": "true",
    },
    body: JSON.stringify({ query, params }),
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `Database request failed with status ${res.status}`);
  return (body.rows ?? []) as Row[];
}

/** Creates the dashboard's tables on first use (same as db/insights-schema.sql). */
export function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
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
    await sql`CREATE TABLE IF NOT EXISTS insights_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}
