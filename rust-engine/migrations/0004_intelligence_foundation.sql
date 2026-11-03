-- Additive intelligence foundation. Existing fixture/history data is untouched.
-- Player identities are source-scoped and require explicit upstream IDs.
CREATE TABLE IF NOT EXISTS player_match_participation (
  id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, fixture_external_id TEXT NOT NULL,
  player_external_id TEXT NOT NULL, player_name TEXT, team_external_id TEXT, team_name TEXT,
  side TEXT, is_starter BOOLEAN, position TEXT, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source,fixture_external_id,player_external_id)
);
CREATE INDEX IF NOT EXISTS player_participation_player_idx ON player_match_participation(source,player_external_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS player_participation_team_idx ON player_match_participation(source,team_external_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS player_participation_pair_idx ON player_match_participation(source,player_external_id,team_external_id,observed_at DESC);

-- Explicit player/team relationship history; names are descriptive, never identity keys.
CREATE TABLE IF NOT EXISTS player_team_history (
  id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, player_external_id TEXT NOT NULL,
  team_external_id TEXT NOT NULL, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), appearances INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source,player_external_id,team_external_id)
);

-- Auditable model registry and immutable evaluation records.
CREATE TABLE IF NOT EXISTS prediction_model_registry (
  model_version TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'shadow',
  feature_spec JSONB NOT NULL DEFAULT '{}'::jsonb, metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), promoted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS prediction_backtests (
  id BIGSERIAL PRIMARY KEY, model_version TEXT NOT NULL, source TEXT NOT NULL,
  competition TEXT, window_start TIMESTAMPTZ, window_end TIMESTAMPTZ, sample_size INTEGER NOT NULL,
  accuracy DOUBLE PRECISION, brier_score DOUBLE PRECISION, log_loss DOUBLE PRECISION,
  calibration_error DOUBLE PRECISION, baseline_brier DOUBLE PRECISION,
  passed BOOLEAN NOT NULL DEFAULT FALSE, details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prediction_backtests_model_idx ON prediction_backtests(model_version,created_at DESC);

-- Retain the evidence/features that were available at prediction time for audit and leakage checks.
ALTER TABLE prediction_history ADD COLUMN IF NOT EXISTS feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE prediction_history ADD COLUMN IF NOT EXISTS calibration_version TEXT;
ALTER TABLE prediction_history ADD COLUMN IF NOT EXISTS prediction_status TEXT NOT NULL DEFAULT 'shadow';
