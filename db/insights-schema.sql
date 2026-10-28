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
