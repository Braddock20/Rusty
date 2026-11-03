-- Additive, odds-independent prediction audit trail. Existing production data is preserved.
CREATE TABLE IF NOT EXISTS prediction_history (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  external_fixture_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  predicted_outcome TEXT NOT NULL CHECK (predicted_outcome IN ('HOME','DRAW','AWAY')),
  home_probability DOUBLE PRECISION NOT NULL CHECK (home_probability BETWEEN 0 AND 1),
  draw_probability DOUBLE PRECISION NOT NULL CHECK (draw_probability BETWEEN 0 AND 1),
  away_probability DOUBLE PRECISION NOT NULL CHECK (away_probability BETWEEN 0 AND 1),
  evidence_strength_score DOUBLE PRECISION NOT NULL CHECK (evidence_strength_score BETWEEN 0 AND 100),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  actual_outcome TEXT CHECK (actual_outcome IN ('HOME','DRAW','AWAY')),
  settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS prediction_history_fixture_idx ON prediction_history(source,external_fixture_id,predicted_at DESC);
CREATE INDEX IF NOT EXISTS prediction_history_score_idx ON prediction_history(model_version,settled_at DESC);
