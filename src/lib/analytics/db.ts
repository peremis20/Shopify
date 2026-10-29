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
    await sql`CREATE TABLE IF NOT EXISTS insights_keyword_lists (
      id bigserial PRIMARY KEY,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_tracked_keywords (
      list_id bigint NOT NULL REFERENCES insights_keyword_lists (id) ON DELETE CASCADE,
      keyword text NOT NULL,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (list_id, keyword)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_autopilot_runs (
      id bigserial PRIMARY KEY,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      trigger text NOT NULL,
      status text NOT NULL DEFAULT 'running',
      summary text
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_autopilot_changes (
      id bigserial PRIMARY KEY,
      run_id bigint REFERENCES insights_autopilot_runs (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      page_url text NOT NULL,
      resource_type text NOT NULL,
      resource_id text NOT NULL,
      query text NOT NULL,
      field text NOT NULL,
      target_id text,
      before_value text,
      after_value text,
      reason text,
      status text NOT NULL,
      baseline_position real,
      baseline_clicks integer,
      baseline_impressions integer,
      evaluated_at timestamptz,
      result_position real,
      result_clicks integer,
      note text
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_serp_snapshots (
      id bigserial PRIMARY KEY,
      account_id bigint NOT NULL,
      query text NOT NULL,
      checked_at timestamptz NOT NULL DEFAULT now(),
      our_position integer,
      results jsonb NOT NULL
    )`;
    await sql`CREATE INDEX IF NOT EXISTS insights_serp_snapshots_lookup ON insights_serp_snapshots (account_id, query, checked_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS insights_rank_daily (
      account_id bigint NOT NULL,
      query text NOT NULL,
      checked_on date NOT NULL,
      position integer,
      url text,
      PRIMARY KEY (account_id, query, checked_on)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_page_health (
      account_id bigint NOT NULL,
      url text NOT NULL,
      checked_at timestamptz NOT NULL DEFAULT now(),
      index_verdict text,
      coverage text,
      last_crawl timestamptz,
      rich_results jsonb,
      perf_score integer,
      lcp_ms integer,
      cls real,
      issues jsonb NOT NULL DEFAULT '[]',
      PRIMARY KEY (account_id, url)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_account_profile (
      account_id bigint PRIMARY KEY,
      brand_name text,
      business_type text,
      site_domain text,
      ga_exclude_hosts text,
      onboarding_dismissed boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_claim_flags (
      account_id bigint NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      kind text NOT NULL,
      flags jsonb NOT NULL,
      checked_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, url)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    // ---- multi-account (SaaS) tables ----
    await sql`CREATE TABLE IF NOT EXISTS insights_accounts (
      id bigserial PRIMARY KEY,
      email text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_account_google (
      account_id bigint PRIMARY KEY REFERENCES insights_accounts (id) ON DELETE CASCADE,
      refresh_token_enc text NOT NULL,
      email text,
      ga_property_id text,
      gsc_site_url text,
      connected_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_account_autopilot (
      account_id bigint PRIMARY KEY REFERENCES insights_accounts (id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT false,
      max_pages_per_week integer NOT NULL DEFAULT 4,
      allow_content boolean NOT NULL DEFAULT true,
      shop_domain text,
      shop_token_enc text,
      last_run_at timestamptz
    )`;
    await sql`ALTER TABLE insights_keyword_lists ADD COLUMN IF NOT EXISTS account_id bigint`;
    await sql`ALTER TABLE insights_autopilot_runs ADD COLUMN IF NOT EXISTS account_id bigint`;
    await sql`ALTER TABLE insights_autopilot_changes ADD COLUMN IF NOT EXISTS account_id bigint`;
    // Carry over the single-owner setup from before accounts existed.
    await sql`INSERT INTO insights_accounts (email)
      SELECT email FROM insights_google_connection WHERE id = 'default' AND email IS NOT NULL
      ON CONFLICT (email) DO NOTHING`;
    await sql`INSERT INTO insights_account_google (account_id, refresh_token_enc, email, ga_property_id, gsc_site_url)
      SELECT a.id, g.refresh_token_enc, g.email, g.ga_property_id, g.gsc_site_url
      FROM insights_google_connection g JOIN insights_accounts a ON a.email = g.email
      WHERE g.id = 'default'
      ON CONFLICT (account_id) DO NOTHING`;
    await sql`UPDATE insights_keyword_lists SET account_id = (SELECT min(id) FROM insights_accounts) WHERE account_id IS NULL`;
    await sql`UPDATE insights_autopilot_runs SET account_id = (SELECT min(id) FROM insights_accounts) WHERE account_id IS NULL`;
    await sql`UPDATE insights_autopilot_changes SET account_id = (SELECT min(id) FROM insights_accounts) WHERE account_id IS NULL`;
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}
