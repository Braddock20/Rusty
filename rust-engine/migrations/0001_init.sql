CREATE TABLE IF NOT EXISTS collection_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  summary JSONB
);
CREATE TABLE IF NOT EXISTS raw_snapshots (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES collection_runs(id),
  source TEXT NOT NULL,
  dataset TEXT NOT NULL,
  external_id TEXT,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_snapshots_lookup ON raw_snapshots(source,dataset,external_id,collected_at DESC);
CREATE TABLE IF NOT EXISTS fixtures (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  competition TEXT,
  home_name TEXT,
  away_name TEXT,
  kickoff_raw TEXT,
  status_raw TEXT,
  home_score_raw TEXT,
  away_score_raw TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source,external_id)
);
CREATE INDEX IF NOT EXISTS fixtures_kickoff ON fixtures(kickoff_raw);
CREATE INDEX IF NOT EXISTS fixtures_source_status ON fixtures(source,status_raw);
CREATE TABLE IF NOT EXISTS score_observations (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_raw TEXT,
  home_score_raw TEXT,
  away_score_raw TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS score_history_match ON score_observations(source,external_id,observed_at DESC);
CREATE TABLE IF NOT EXISTS odds_observations (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'betika',
  external_fixture_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  odds_raw TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS odds_history_match ON odds_observations(external_fixture_id,market,selection,observed_at DESC);
CREATE TABLE IF NOT EXISTS entity_mappings (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  source_a TEXT NOT NULL,
  external_id_a TEXT NOT NULL,
  display_name_a TEXT NOT NULL,
  source_b TEXT NOT NULL,
  external_id_b TEXT NOT NULL,
  display_name_b TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(entity_type,source_a,external_id_a,source_b,external_id_b)
);
CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
-- The views are dropped and recreated rather than replaced in place, and they carry the
-- same columns as the versions introduced by 0002. CREATE OR REPLACE VIEW cannot drop
-- columns, so the original definition made this migration fail with
-- "cannot drop columns from view" whenever it was applied after 0002 (for example when
-- the full set is re-applied on every service start).
DROP VIEW IF EXISTS latest_score;
CREATE VIEW latest_score AS
SELECT DISTINCT ON (source,external_id) source,external_id,observed_at,status_raw,home_score_raw,away_score_raw,id
FROM score_observations ORDER BY source,external_id,observed_at DESC,id DESC;
DROP VIEW IF EXISTS latest_odds;
CREATE VIEW latest_odds AS
SELECT DISTINCT ON (source,external_fixture_id,market,selection)
 source,external_fixture_id,market,selection,observed_at,odds_raw,id
FROM odds_observations ORDER BY source,external_fixture_id,market,selection,observed_at DESC,id DESC;
