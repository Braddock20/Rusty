# Rusty Production Hardening Report

## Scope

This release hardens the Cloudflare Worker collection and read/prediction API against the confirmed defects found in the live API tests and the future failure modes that can reasonably be mitigated in application code. It does not claim that third-party providers, Cloudflare, or Neon can never fail. It does not bypass provider access restrictions.

The Cloudflare Worker is the active production collection path. The Rust service remains legacy/experimental and is not covered by this patch; do not run its collector concurrently against the production database.

## Confirmed defects addressed in code

1. **Expired collection leases / stale runs / overlapping runs** — lease acquisition and run creation now occur in one PostgreSQL statement. A three-minute lease is renewed by an independent heartbeat and at work checkpoints. Every checkpoint verifies ownership. Old runs are reconciled by stale heartbeat, not merely by age since start. A run has an eight-minute application time budget and is finalized as success, partial, or failed. The old owner cannot release a newer owner's lease or overwrite its source-health record.
2. **Concurrent source collectors / early Promise rejection** — providers are processed sequentially. A source failure is isolated; a failed Promise cannot release the lease while other collectors continue writing.
3. **Betika `Unexpected end of JSON input`** — empty and malformed bodies now produce stable provider-specific errors, with one bounded retry. The response must contain the expected `data[]` shape before ingestion.
4. **eAdriatic HTTP 429** — no immediate retry loop. `Retry-After` seconds or HTTP-date and the provider's `retry_after_seconds` are interpreted and persisted as a cooldown. Access restrictions are never bypassed.
5. **GT HTTP 451** — access restriction is reported and not retried or bypassed.
6. **Pagination stopping silently at a fixed page cap** — GT offset and Betika page cursors are persisted in `collection_checkpoints` and resumed on later runs. A capped batch is not silently treated as a complete crawl.
7. **Partial/incorrect source health** — source attempt time, last success, record count, error code, consecutive failures and cooldown are exposed. A superseded run cannot overwrite health after losing the lease.
8. **`/api/v1/collection/status` route returning source data** — the route returns lock, run heartbeat, recent runs and pagination checkpoints.
9. **`/api/v1/results` returning fixtures** — results now require `result_state='completed'` and valid integer scores.
10. **Ambiguous eAdriatic `Normal / Scheduled` records appearing like results** — scores and approval flags are not treated as completion. Existing rows default to `unknown`; new observations are classified only from explicit provider status labels.
11. **Prediction history using scored but ambiguous fixtures** — model history now uses only explicitly completed fixtures with integer scores.
12. **Name-only team identity joins** — prediction team form, ratings and head-to-head require explicit source-scoped team IDs. Names remain display labels. If IDs are absent, the engine abstains rather than merging possibly unrelated teams.
13. **Recent-form ordering** — the most recent ten completed fixtures are selected in correct chronological order.
14. **Default ratings/expected goals looking like learned evidence** — those fields are null when the verified sample threshold is not met; probabilities and predictions are withheld.
15. **Unregistered model label** — new forecasts use `rusty-shadow-v2`, registered as `shadow`, not as a validated/promoted model.
16. **Repeated forecast insertion** — `prediction_forecast_keys` provides an atomic unique claim per source/fixture/model. The first pre-match forecast is immutable and cannot be duplicated by concurrent API requests.
17. **Prediction performance SQL rounding** — multiclass Brier rounding casts the aggregate to `numeric`; settlement uses only explicitly completed fixtures. If a provider corrects a final score, the settled outcome is recalculated from the latest completed fixture state.
18. **Invalid query limits** — malformed, negative and excessively large `limit`/`offset` values are safely bounded.
19. **Unknown API paths / malformed fixture IDs** — unknown paths return 404; invalid encoded fixture IDs return 400; manual collection requires POST and the admin token.
20. **Public error leakage** — unexpected API failures return a request ID and generic error while details are written to Worker logs. JSON responses disable caching and set `nosniff`.

## Additive database migration

Apply `rust-engine/migrations/0006_production_hardening.sql` after migrations 0001-0005. It adds:

- `collection_runs.owner_token`, `heartbeat_at`;
- `collection_lock.run_id` (and idempotently ensures `owner_token` exists);
- source-health attempt, record-count and error-code fields;
- `fixtures.result_state`, `home_team_external_id`, `away_team_external_id`;
- `score_observations.result_state`;
- durable `collection_checkpoints`;
- `prediction_forecast_keys`, backfilled from existing forecast history.

The migration is additive. It does not delete fixtures, snapshots, score observations, odds observations, predictions or runs. The recovered 212 eAdriatic fixtures remain intact. They are deliberately not backfilled as completed because their stored status (`Normal / Scheduled`) is ambiguous.

## Validation performed in this workspace

- `npm test`: **12 tests passed, 0 failed**.
- Node TypeScript syntax checks: passed for all Worker source files.
- Strict TypeScript check: passed using temporary ambient declarations for the Cloudflare and Neon packages.
- Full `npx tsc --noEmit` and Wrangler build/deploy were not run because the package install timed out in this environment and the project dependencies were not present. Run those commands in the deployment environment after `npm install`.
- No live Neon database migration or live provider request was executed from this workspace. Production integration must be verified after you apply the migration and deploy.

## Known limits that code cannot eliminate

- eAdriatic may continue returning HTTP 429. Rusty waits for the stated cooldown; only the provider can restore access sooner.
- GT may continue returning HTTP 451. Rusty will not bypass the restriction; collection can only resume if the provider makes an authorized endpoint available.
- Betika may still return empty, truncated or malformed responses. Rusty will classify and record them, but cannot repair the provider's response.
- Provider status vocabulary may evolve. Unrecognized status values remain `unknown` until explicitly mapped and tested. This may temporarily reduce `/results` counts; it prevents false results.
- Existing eAdriatic rows remain visible in `/api/v1/fixtures`, but are excluded from `/api/v1/results` and prediction history until explicit completion status is observed.
- Team-specific predictions require explicit upstream team IDs and at least 12 completed historical matches per participant within the same source/competition ID. If the feeds do not supply them, the model correctly returns `PASS_INSUFFICIENT_VERIFIED_HISTORY`.
- Kickoff strings without a timezone or epoch are rejected for forecasting rather than guessed. This can reduce the number of forecast candidates until provider timezones are verified.
- The prediction model remains shadow-only. There is no proven accuracy, calibration or profitability claim. `/api/v1/predictions/performance` can remain empty until genuine pre-match forecasts are later settled.
- The optional Rust service was not compiled or hardened in this release. Do not deploy its collector as a second writer alongside the Worker.
- No software patch can promise zero future errors. This release aims to prevent silent corruption, false results, duplicate forecasts, unbounded retries and overlapping collection runs, and to make failures diagnosable.

## Deployment sequence

1. Back up the Neon database before schema changes.
2. Confirm migrations 0001-0005 are already applied.
3. Apply `rust-engine/migrations/0006_production_hardening.sql` in the Neon SQL editor or with `psql`.
4. Deploy the complete `cloudflare/` Worker source from this release, not just one file.
5. In `cloudflare/`, run `npm install`, `npm test`, `npx tsc --noEmit`, then `npx wrangler deploy`.
6. Do not manually trigger collection while `/api/v1/collection/status` reports an active lease.
7. Verify `/api/v1/health`, `/api/v1/sources`, `/api/v1/collection/status`, `/api/v1/runs?limit=5`, `/api/v1/fixtures`, `/api/v1/results`, `/api/v1/predictions`, and `/api/v1/predictions/performance`.
8. Confirm each run reaches a terminal status with `finished_at`, the lock is released, provider health is updated, and pagination cursors advance/reset as expected.

## Release identity

This is a source-code hardening patch based on the uploaded project archive. It is not deployed to the user's Cloudflare or Neon account by this report.
