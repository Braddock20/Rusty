-- Safe additive migration for the existing Neon database. No existing rows are deleted.
CREATE TABLE IF NOT EXISTS collection_lock (
  lock_name TEXT PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS standings (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  competition TEXT,
  external_team_id TEXT NOT NULL,
  team_name TEXT,
  position INTEGER,
  points INTEGER,
  played INTEGER,
  won INTEGER,
  tied INTEGER,
  lost INTEGER,
  score_for INTEGER,
  score_against INTEGER,
  win_percentage DOUBLE PRECISION,
  recent_form TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS standings_latest_idx
  ON standings(source, competition, external_team_id, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS odds_history_deterministic_idx
  ON odds_observations(source, external_fixture_id, market, selection, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS score_history_deterministic_idx
  ON score_observations(source, external_id, observed_at DESC, id DESC);

CREATE OR REPLACE VIEW latest_score AS
SELECT DISTINCT ON (source,external_id)
  source,external_id,observed_at,status_raw,home_score_raw,away_score_raw,id
FROM score_observations
ORDER BY source,external_id,observed_at DESC,id DESC;

CREATE OR REPLACE VIEW latest_odds AS
SELECT DISTINCT ON (source,external_fixture_id,market,selection)
  source,external_fixture_id,market,selection,observed_at,odds_raw,id
FROM odds_observations
ORDER BY source,external_fixture_id,market,selection,observed_at DESC,id DESC;
