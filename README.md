# Rusty eSoccer Intelligence Engine — Cloudflare Worker + Neon

Rusty collects real eSoccer data from eAdriatic/LeagueRepublic, GT Sports League and Betika into Neon PostgreSQL. The currently active production path is the **Cloudflare Worker native collector** in `cloudflare/`, with Neon as the canonical store. The Rust service in `rust-engine/` is retained as an optional legacy/experimental service; do not run its collector in parallel with the Worker until it has separately passed the same reliability and data-integrity checks.

> **See `FIX-REPORT.md`** for the defects that were reproduced and fixed in this pass,
> including the lease bug that prevented collection from running at all, the query-limit
> bug that made every list endpoint return a single row, and the GT/eAdriatic payload
> mismatches that stopped both upstream sources from being ingested.

## Production architecture

- **Cloudflare Worker** (`cloudflare/`): public read API and five-minute Cron Trigger; owns the active collection path and odds-free shadow prediction API.
- **Neon PostgreSQL**: canonical persistent store. Raw snapshots, normalized fixtures, score observations, odds observations, provider health, run ownership, pagination checkpoints and forecast audit history are retained.
- **Rust service** (`rust-engine/`): legacy/experimental implementation. It is not the deployed Worker code and is not covered by the Worker validation results in this release.

## Reliability policy and limits

No software can guarantee that third-party APIs, Cloudflare or a database will never fail. Rusty is designed to fail safely: it validates upstream responses, respects provider restrictions and rate limits, records source-level failures, uses an atomic database lease with heartbeats, bounds each scheduled run, resumes paginated collection, and refuses to treat ambiguous scores as completed results.

- HTTP 401/403/451 are not retried or bypassed. GT HTTP 451 remains an access restriction.
- HTTP 429 is not retried immediately. `Retry-After` is persisted as a source cooldown.
- Empty or malformed JSON is reported with a stable provider-specific error; malformed responses receive one bounded retry.
- Only transient network/408/425/5xx failures receive one bounded retry.
- Pagination resumes from durable checkpoints. It does not silently claim that a capped page batch is the complete provider history.
- A match is a result only when the provider status is explicitly recognized as terminal and scores are valid. Approval flags or scores alone are insufficient.
- Team identity is source-scoped and requires explicit upstream team IDs. Names are labels, not identity keys.
- Forecasts remain shadow-only until chronological walk-forward validation and calibration pass. Bookmaker odds are not model inputs.

The existing 212 recovered eAdriatic fixtures are preserved. Migration 0006 gives existing fixtures `result_state='unknown'` rather than guessing that their scores mean they are completed. They remain available from `/api/v1/fixtures`; they are excluded from `/api/v1/results` and predictive history until a provider explicitly confirms completion.

## Requirements

- Node.js 22.6+ and npm
- PostgreSQL / Neon connection string
- Cloudflare account and Wrangler for Worker deployment
- Rust stable is needed only if separately developing the optional legacy Rust service

## Run and test the production Worker locally

```bash
cd cloudflare
npm install
npm test
npx wrangler dev
```

Configure the `DATABASE_URL` secret/binding in the local Wrangler environment. Do not commit credentials or `.dev.vars` files.

The unit tests run without any external service. The integration tests in
`test/worker.integration.test.ts` execute the **unmodified Worker** against a real
PostgreSQL database and are skipped unless `DATABASE_URL` is set:

```bash
# create the database, then apply the migrations
for f in rust-engine/migrations/000*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done

DATABASE_URL="postgres://user:pass@localhost:5432/rusty" npm test
```

`test/helpers/neon-shim.ts` implements the Neon HTTP `/sql` protocol on top of
PostgreSQL, so the Worker talks to the database through the same driver it uses in
production. Upstream provider calls are served deterministic fixtures in
`test/helpers/provider-fixtures.ts`, which mirror the real payload shapes.

The optional Rust service is not the active production collector. Its collectors and API are not covered by this Worker hardening release; do not run it as a second writer against the production Neon database.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon/PostgreSQL connection string (required) |
| `ADMIN_TOKEN` | Bearer token for the manual `POST /api/v1/collection/run` endpoint (optional) |
| `BETIKA_UTC_OFFSET_MINUTES` | Offset of the Betika provider clock, e.g. `180` for UTC+3. Betika publishes `start_time` as a timezone-less local string; without this setting the value is stored but never used as a forecast candidate, because an ambiguous local time is never guessed. |

## Deploy Cloudflare Worker

Apply migrations 0001 through 0005 if they have not already been applied. Then apply the new additive hardening migration:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f rust-engine/migrations/0006_production_hardening.sql
```

From `cloudflare/`:

```bash
npm install
npm test
npx tsc --noEmit
npx wrangler deploy
```

The existing `*/5 * * * *` Cron Trigger is retained. The Worker reads `DATABASE_URL` from its secret. Set `ADMIN_TOKEN` only if you want the authenticated manual endpoint `/api/v1/collection/run`; use `npx wrangler secret put ADMIN_TOKEN`. Never expose this token in a browser.

Do not manually trigger a collection until migration 0006 has completed and the Worker deployment has finished. A previously active lease from an older deployment may need to expire before the new collector can acquire it.

## Data model

- `raw_snapshots`: append-only raw response records with source, dataset, external ID and
  collection timestamp.
- `fixtures`: latest normalized fixture state, unique by source + external fixture ID.
- `score_observations`: append-only score/status time series.
- `odds_observations`: append-only bookmaker market/selection price time series.
- `entity_mappings`: explicit source-to-source participant identity mapping; never auto-merge
  ambiguous nicknames.
- `collection_runs`, `source_health`: audit and operational state.

## Operational policy

- eAdriatic: keep request volume below the observed 30 calls/minute limit and honor HTTP 429 `Retry-After` cooldowns. No rate-limit bypass is attempted.
- GT: send ordinary `Origin` and `Referer` headers; validate response shape; stop on 401/403/451 without bypass attempts. Fixture pages resume from durable offsets.
- Betika: validate `data[]`, distinguish empty/malformed bodies, and resume page-based collection. This feed is not treated as a verified historical-results endpoint.
- Collection runs are bounded, sequential across providers, lease-protected and heartbeat-monitored. Each provider failure is isolated and recorded.
- Keep raw snapshots and append-only observations. Do not delete historical data as a troubleshooting shortcut.
- Prediction history is immutable per source/fixture/model; only explicit completed scores settle forecasts. Odds are excluded from prediction features.
- Cron is a trigger, not a guarantee of exact execution time. Always inspect run status and source health rather than assuming a scheduled trigger succeeded.

## First production deployment checklist

1. Confirm migrations 0001 through 0005 are already applied.
2. Apply `rust-engine/migrations/0006_production_hardening.sql` to Neon.
3. Confirm the Worker has its `DATABASE_URL` secret and the correct account/environment.
4. Run `npm test` and `npx tsc --noEmit` from `cloudflare/`.
5. Deploy the Worker.
6. Verify `/api/v1/health`, `/api/v1/sources`, and `/api/v1/collection/status`.
7. Wait for a scheduled run to complete; do not trigger a second run while a lease is active.
8. Inspect `/api/v1/runs` and provider health; distinguish `success`, `partial`, `failed`, and skipped due to an active lease.
9. Verify `/api/v1/results` contains only explicitly completed fixtures.
10. Keep predictions in shadow mode until real chronological backtests and calibration pass.

## Included commands

```bash
cargo test
cargo run
```


## Cloudflare-native collection and operational checks

The Worker collects directly from the three configured providers. It uses a three-minute renewable lease, independent heartbeat, eight-minute run budget, per-fixture ownership checkpoints, and sequential source isolation. A scheduled invocation that cannot acquire the lease exits without starting a duplicate run. Old runs are reconciled only after their heartbeat is stale.

GT and Betika pagination cursors are stored in `collection_checkpoints` and resumed on later Cron runs. A full page at the configured per-run page cap is not reported as a fully completed historical crawl; the cursor advances instead. eAdriatic collection observes a conservative inter-season delay and honors HTTP 429 cooldowns. GT access restrictions are respected without bypass attempts.

Operational endpoints:
- `GET /api/v1/health` — Worker-to-Neon connectivity.
- `GET /api/v1/sources` — all expected providers and latest attempt/success/error/cooldown details.
- `GET /api/v1/collection/status` — lease owner, run heartbeat, recent runs and pagination cursors.
- `GET /api/v1/runs?limit=25` — run history.
- `GET /api/v1/fixtures` — all normalized fixtures, including ambiguous historical rows.
- `GET /api/v1/results` — only explicitly completed fixtures with valid scores.

## Odds-free prediction engine (experimental shadow mode)

Migrations 0003 and 0004 provide the prediction schema; migration 0006 adds the hardening and forecast-claim tables. The Worker exposes:

- `GET /api/v1/predictions?limit=30` — upcoming fixtures with experimental, odds-free model forecasts; optionally filter with `&source=betika`, `eadriatic`, or `gt`.
- `GET /api/v1/predict` — alias for the same endpoint.
- `GET /api/v1/predictions/performance` — settled walk-forward forecast record (accuracy and multiclass Brier score).

The experimental `rusty-shadow-v2` ensemble combines a recency-weighted Elo rating with a score-distribution model using completed historical goals for/against and shrinkage toward source/competition averages. It reads fixtures marked `result_state=completed` only; it never queries or uses `odds_observations`. The first pre-match forecast per fixture/model is immutable and protected against concurrent duplicate insertion. A forecast is withheld unless at least 12 completed, source-scoped matches per participant can be linked using explicit team IDs and a verified competition ID. Team names alone are never identity keys. Ambiguous local-time kickoff strings are rejected rather than guessed. The current version is deliberately marked `SHADOW_ONLY_UNVALIDATED` or `PASS_*`; do not use it as a betting recommendation. Its probability outputs are model estimates, not accuracy percentages. `evidence_strength_score` measures sample support, not chance of winning.

Before promoting a model to actionable status, build and pass chronological walk-forward tests on the actual eAdriatic and GT datasets, compare against simple baselines, report accuracy plus log loss/Brier score and calibration by probability bucket, and retain a truly untouched final test period. The currently recovered eAdriatic records do not have verified completed status, and GT previously returned HTTP 451. Those limitations mean this patch cannot claim a validated accuracy rate. Betika may supply fixture names/scores for its competitions, but its odds are excluded from every prediction feature.

## Rusty intelligence foundation (migration 0004)

Migration 0004 creates the intelligence foundation and is a prerequisite for the current Worker player and model-registry endpoints. It is additive and preserves existing production rows. It creates source-scoped player/team participation history, player-team relationship history, model registry, backtest records, and prediction feature snapshots.

New endpoints:
- `GET /api/v1/intelligence/status` — data coverage and model registry status.
- `GET /api/v1/players` — only source-identified players observed in GT participant payloads.
- `GET /api/v1/players/:source_player_id?source=gt` — observed appearances, confirmed starts, unknown start status, and team associations.

GT collection now records player/team relationships only when the upstream fixture explicitly provides player IDs and team IDs. Starter status and position are nullable and remain unknown unless the source explicitly supplies them. Names are never used to merge identities across sources. The prediction response now includes last-ten form, head-to-head summary, and player/team pairing evidence where verified IDs and history exist. These player/team observations are currently explanatory evidence, not a model weight; they must pass independent walk-forward ablation tests before they influence forecast probabilities.

Predictions remain odds-free and shadow-only. `probabilities` are model estimates, not accuracy percentages. `evidence_strength_score` is not a probability. The system must not promote a model based on hit rate alone: promotion requires adequate sample size, improvement over simple baselines on chronological holdouts, acceptable Brier score/log loss, calibration checks, and stable performance across source/competition/time segments. No 99.999% accuracy is promised.

### Production hardening release

Migration `0006_production_hardening.sql` is additive. It adds run ownership/heartbeat fields, source attempt diagnostics, explicit result state, explicit home/away team IDs, durable pagination checkpoints, and a unique forecast-claim table. It does not delete or rewrite the 212 recovered eAdriatic records or existing forecast history. Existing fixture result states default to `unknown` by design.

The Worker test suite includes provider-status classification, malformed/empty JSON handling, retry policy, safe query bounds, timestamp ambiguity rejection, and normalization tests. A TypeScript syntax/type pass can be run with the project's installed dependencies; live Neon/Cloudflare integration and live provider calls must still be verified after deployment.

The Rust service remains experimental and is not covered by this Worker patch. Do not deploy both Rust and Worker collectors against the same Neon database as parallel scheduled writers.

### Required next data capabilities

The existing upstream feeds do not yet guarantee complete player lineups, confirmed starters, per-player in-game actions, controller/formation settings, or match-state telemetry. The new schema preserves explicit participant data when present, but does not fabricate missing fields. Those signals can only become model inputs after a lawful, stable source supplies them and their timestamps prove they were known before kickoff. GT HTTP 451 and LeagueRepublic 429 must continue to be respected; do not bypass access controls or rate limits.
