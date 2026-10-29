-- Tables for the Insights dashboard (/analytics). The app also creates
-- these on first use, so running this file by hand is optional.

-- The connected Google account. One row: the dashboard has a single owner.
-- The refresh token is encrypted by the app before it is stored.
CREATE TABLE IF NOT EXISTS insights_google_connection (
  id                text PRIMARY KEY DEFAULT 'default',
  refresh_token_enc text NOT NULL,
  email             text,
  ga_property_id    text,
  gsc_site_url      text,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Recent API responses, so reloads are fast and Google quotas go further.
CREATE TABLE IF NOT EXISTS insights_report_cache (
  cache_key  text PRIMARY KEY,
  data       jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Saved keyword lists, and the keywords in each (tracked in the ranking tracker).
CREATE TABLE IF NOT EXISTS insights_keyword_lists (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS insights_tracked_keywords (
  list_id  bigint NOT NULL REFERENCES insights_keyword_lists (id) ON DELETE CASCADE,
  keyword  text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, keyword)
);

-- Settings entered in the dashboard (Google OAuth client, Google Ads), encrypted.
CREATE TABLE IF NOT EXISTS insights_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Autopilot: each run, and every change it made (with the old value for undo).
CREATE TABLE IF NOT EXISTS insights_autopilot_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  trigger     text NOT NULL,
  status      text NOT NULL DEFAULT 'running',
  summary     text
);

CREATE TABLE IF NOT EXISTS insights_autopilot_changes (
  id                   bigserial PRIMARY KEY,
  run_id               bigint REFERENCES insights_autopilot_runs (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  page_url             text NOT NULL,
  resource_type        text NOT NULL,
  resource_id          text NOT NULL,
  query                text NOT NULL,
  field                text NOT NULL,       -- meta_title, meta_description, content, alt, internal_link
  target_id            text,                -- image id, or the article that received a link
  before_value         text,
  after_value          text,
  reason               text,
  status               text NOT NULL,       -- applied, kept, reverted, failed, skipped
  baseline_position    real,
  baseline_clicks      integer,
  baseline_impressions integer,
  evaluated_at         timestamptz,
  result_position      real,
  result_clicks        integer,
  note                 text
);

-- Google page one for searches the autopilot works on, to spot who moved above us.
CREATE TABLE IF NOT EXISTS insights_serp_snapshots (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL,
  query text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  our_position integer,
  results jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS insights_serp_snapshots_lookup ON insights_serp_snapshots (account_id, query, checked_at DESC);

-- Daily Google positions for the searches that matter most.
CREATE TABLE IF NOT EXISTS insights_rank_daily (
  account_id bigint NOT NULL,
  query text NOT NULL,
  checked_on date NOT NULL,
  position integer,
  url text,
  PRIMARY KEY (account_id, query, checked_on)
);

-- Index status, rich results and mobile speed per page.
-- Claim guard: risky health claims found in the store's posts, pages and products (weekly).
CREATE TABLE IF NOT EXISTS insights_claim_flags (
  account_id bigint NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  kind text NOT NULL,          -- article, page, product
  flags jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, url)
);

CREATE TABLE IF NOT EXISTS insights_page_health (
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
);
