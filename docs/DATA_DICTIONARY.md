# Data dictionary and analysis protocol

## Identity
Use `(source, external_id)` as the source-local fixture key. Do not join EAL/GT to Betika
by display name alone. Competition history requires explicit `competition_external_id`; team-specific history
requires explicit `home_team_external_id` and `away_team_external_id`; names are labels only. Create `entity_mappings` rows only after human verification.

## Historical observations
- `raw_snapshots`: exact JSON response bodies, timestamped by ingestion.
- `score_observations`: append-only observations when score/status/result-state changes.
- `odds_observations`: each bookmaker selection price observed at collection time.
- `fixtures`: latest known normalized state, not a history table. `result_state` is one of
  `unknown`, `scheduled`, `live`, `completed`, `cancelled`, or `postponed`; ambiguous historical
  rows remain `unknown` until an explicit provider status is observed.
- `collection_checkpoints`: resumable provider pagination cursor; `last_complete_at` is set only
  when a short/empty final page proves the current offset crawl reached its end.
- `prediction_forecast_keys`: atomic uniqueness claim preventing duplicate first forecasts per
  source, fixture and model version.

## Baseline analysis features
1. Player/participant rolling win, draw, loss and goal rates from verified completed fixtures.
2. Head-to-head count and outcomes, with minimum sample size.
3. Recency-weighted form, calculated only from matches completed before prediction time.
4. Market implied probabilities from decimal odds: `1 / odds`; normalize over 1X2 selections.
5. Compare model probabilities with market-implied probabilities and track closing-price movement.
6. Evaluate with chronological train/test splits, Brier score, log loss, calibration and ROI after
   bookmaker margin and realistic execution assumptions.
7. Store prediction timestamp, feature cutoff, model version, probabilities and eventual outcome.

Do not use future fixtures/results in historical features. Do not treat missing data as zero.
Do not issue predictions until data quality, entity mappings and sample sizes pass validation.
