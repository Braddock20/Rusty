# Rusty eSoccer Intelligence — design and promotion standard

## Non-negotiable principles

1. No bookmaker odds in feature generation, training labels, model selection, calibration, or tie-breaking.
2. No fabricated player identity, starter status, lineup, team assignment, tactical data, or match event.
3. Every forecast is timestamped and stores the exact feature snapshot available at forecast time.
4. Only completed, source-confirmed outcomes settle predictions. Corrections are retained as observations; in-play scores are not treated as final.
5. A model stays in shadow until it beats simple baselines on chronological, out-of-sample evaluation and is calibrated.
6. Abstention is a valid prediction-system action. Low evidence, conflicting models, stale feeds, unknown participants, or distribution shift can force PASS.

## Feature families to collect when actually available

- Fixture integrity: stable fixture IDs, competition/season, kickoff, source timestamps, status transitions, duplicate/correction detection.
- Competitor form: recency-weighted wins/draws/losses, score differential, attack/defence rates, volatility, streaks, rest interval where meaningful, opponent-adjusted strength.
- Pairing effects: head-to-head history, direction-aware home/away pairing, repeat-opponent effects, sample-size shrinkage.
- Player identity: source-scoped player IDs, aliases only through verified mappings, player appearances, confirmed starts, bench/substitute status, role/position, player-team spells.
- Player × team effects: player performance with this exact team, performance with other teams, transfer/change-point detection, teammate/lineup interaction when lineups exist.
- Team context: verified team IDs, standings and season context, roster stability, team changes, schedule density if match timestamps support it.
- Match telemetry: goals by time, shots, possession, attacks, cards, substitutions, events and state transitions only if a source exposes reliable timestamped data.
- Data quality: source freshness, missingness, contradictions, identity certainty, sample size, upstream outage, timestamp reliability.

## Model candidates — benchmark, do not blindly stack

- Dynamic Elo / Glicko-style ratings for time-varying competitor strength.
- Bradley–Terry / Davidson models for paired strength and draws.
- Hierarchical Poisson / Dixon–Coles-style score models for score distributions and draw dependence.
- Player-rating aggregation and player × team hierarchical effects once player-level observations are sufficiently complete.
- Regularized multinomial logistic regression as an interpretable baseline.
- Gradient-boosted trees only if the dataset is large enough and chronological tests show robust incremental value.
- Bayesian hierarchical shrinkage for sparse players, teams, pairings and new seasons.
- Change-point / drift detectors to down-weight obsolete history after roster, competitor, or meta changes.
- A calibrated ensemble whose weights are learned only from past out-of-fold predictions; never fixed by intuition.

## Validation and release gates

- Strict rolling-origin / walk-forward validation; all features for a historical prediction must be cut off at that prediction timestamp.
- Compare against majority-class, competition base-rate, recent-form, and simple Elo baselines.
- Report multiclass accuracy alongside Brier score, log loss, calibration/reliability bins, class-wise recall, confusion matrix, coverage, and abstention rate.
- Bootstrap confidence intervals and minimum sample thresholds; segment by source, competition, time period, and data-quality tier.
- Feature-family ablation to prove each extra signal helps rather than adds noise.
- Shadow challenger models run beside the champion; promotion only after predeclared thresholds and no material segment regressions.
- Drift monitoring and automatic demotion/abstention when calibration or data quality degrades.

## Current implementation boundary

The current feeds provide fixture names, dates/status, scores, some standings, raw payloads and (for GT when explicit IDs are present) participant/player/team objects. They do not establish complete starting lineups, reliable player performance statistics, tactics, controller settings or in-game event streams. The migration and collector preserve player/team participation when IDs exist. Pairing history is returned as explanatory evidence, not yet used to move probabilities. These inputs must be independently validated before model integration.
