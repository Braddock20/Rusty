# Data dictionary and analysis protocol

## Identity
Use `(source, external_id)` as the source-local fixture key. Do not join EAL/GT to Betika
by display name alone. Create `entity_mappings` rows only after human verification.

## Historical observations
- `raw_snapshots`: exact JSON response bodies, timestamped by ingestion.
- `score_observations`: each score/status observation, including repeated unchanged states.
- `odds_observations`: each bookmaker selection price observed at collection time.
- `fixtures`: latest known normalized state, not a history table.

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
