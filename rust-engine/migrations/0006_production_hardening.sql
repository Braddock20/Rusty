-- Additive production hardening. Existing fixtures, snapshots and forecasts are preserved.
ALTER TABLE collection_lock ADD COLUMN IF NOT EXISTS owner_token TEXT;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;
ALTER TABLE collection_lock ADD COLUMN IF NOT EXISTS run_id BIGINT;
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS owner_token TEXT;
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS last_record_count INTEGER;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS result_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS competition_external_id TEXT;
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS home_team_external_id TEXT;
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS away_team_external_id TEXT;
ALTER TABLE score_observations ADD COLUMN IF NOT EXISTS result_state TEXT NOT NULL DEFAULT 'unknown';
CREATE INDEX IF NOT EXISTS collection_runs_heartbeat_idx ON collection_runs(status, heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS fixtures_result_state_idx ON fixtures(source, result_state, kickoff_raw);
CREATE INDEX IF NOT EXISTS fixtures_team_history_idx ON fixtures(source, home_team_external_id, away_team_external_id, kickoff_raw);
CREATE INDEX IF NOT EXISTS fixtures_competition_history_idx ON fixtures(source, competition_external_id, result_state, kickoff_raw);
CREATE INDEX IF NOT EXISTS prediction_history_immutable_lookup_idx ON prediction_history(source, external_fixture_id, model_version, predicted_at);
CREATE TABLE IF NOT EXISTS collection_checkpoints (
  source TEXT NOT NULL,
  dataset TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '0',
  last_complete_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source, dataset)
);
CREATE TABLE IF NOT EXISTS prediction_forecast_keys (
  source TEXT NOT NULL,
  external_fixture_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source, external_fixture_id, model_version)
);
INSERT INTO prediction_forecast_keys(source,external_fixture_id,model_version)
SELECT DISTINCT source,external_fixture_id,model_version FROM prediction_history
ON CONFLICT(source,external_fixture_id,model_version) DO NOTHING;
