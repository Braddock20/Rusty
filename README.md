# Esports Data Engine — Hybrid Rust + Cloudflare + Neon

A deployable starting implementation for collecting official eAdriatic (LeagueRepublic),
GT Sports League and Betika eSoccer data into Neon PostgreSQL, preserving timestamped
observations for later analysis and backtesting.

## Architecture

- **Rust engine** (`rust-engine/`): long-running collector/API service. Owns HTTP clients,
  source-specific pagination, normalization, validation, and PostgreSQL persistence.
- **Cloudflare Worker** (`cloudflare/`): public read API + Cron Trigger. Calls the Rust
  engine's authenticated `/internal/collect` endpoint. It does not duplicate scraping.
- **Neon PostgreSQL**: canonical persistent store. Raw JSON snapshots are retained alongside
  normalized fixtures, score observations, odds observations, and source identity mappings.
- **Analysis**: SQL views and baseline feature queries are included. Predictive models should
  only be trained after sufficient verified historical observations have accumulated.

## Important truth about completeness

This repository contains the full application structure and runnable collection pipeline,
but no one can honestly guarantee every undocumented upstream endpoint/schema from a pasted
catalog alone. The source adapters are deliberately defensive and retain raw payloads. Before
using the data for betting decisions, run `verify` and inspect `source_health`; verify GT
HTTP 200 responses and real response bodies from your own deployment. No endpoint is bypassed
or accessed using private credentials.

The upstream API catalog supplied in the project notes is treated as a configuration baseline.
Endpoint availability, IDs, response shapes, league-to-bookmaker player mappings and Betika
historical results remain things to validate against live responses.

## Requirements

- Rust stable (1.80+ recommended)
- PostgreSQL / Neon connection string
- Cloudflare account for Worker deployment
- A publicly reachable HTTPS deployment for the Rust engine (VPS/container host)
- `wrangler` for Worker deployment

## Run locally

```bash
cd rust-engine
cp .env.example .env
# Edit DATABASE_URL and INTERNAL_TOKEN. Never commit .env.
cargo run
```

Health:
```bash
curl http://localhost:8080/health
curl http://localhost:8080/health/db
```

Run one collection cycle:
```bash
curl -X POST http://localhost:8080/internal/collect \
  -H "Authorization: Bearer $INTERNAL_TOKEN"
```

Check:
```bash
curl http://localhost:8080/api/v1/health
curl http://localhost:8080/api/v1/fixtures?source=gt&limit=20
```

## Deploy Rust engine

Build and run with Docker:

```bash
docker build -t esports-engine ./rust-engine
docker run --env-file ./rust-engine/.env -p 8080:8080 esports-engine
```

Set `PORT`, `DATABASE_URL`, `INTERNAL_TOKEN`, source base URLs and optional IDs in the host's
secret/environment settings. Put the service behind HTTPS. Restrict `/internal/*` with the
token; do not expose the token to browsers.

## Deploy Cloudflare Worker

```bash
cd cloudflare
npm install
npx wrangler secret put ENGINE_URL
npx wrangler secret put ENGINE_TOKEN
npx wrangler deploy
```

`ENGINE_URL` is the public HTTPS base URL of the Rust service. `ENGINE_TOKEN` must equal
`INTERNAL_TOKEN` on the Rust service. Configure the Cron schedule in `wrangler.toml`.

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

- EAL: default to no more than 30 calls/minute, cache season/group metadata, exponential
  backoff on 429, and honour `Retry-After`.
- GT: send ordinary `Origin` and `Referer` headers for the official site; assert HTTP 200;
  page at no more than 200 rows, increment offset by actual returned rows, stop on empty page.
  Use a conservative delay and stop if upstream returns 401/403/451.
- Betika: use the public matches endpoint already observed; poll at a polite interval. The
  current adapter captures available upcoming eSoccer fixtures and 1X2 odds. It does not
  pretend to have a verified historical results endpoint.
- Cron is a trigger, not a guarantee of exact execution time. Rust service scheduling is
  controlled by the host. For live score tracking, use a VPS process or frequent external
  triggers, within source terms and rate limits.
- Keep raw snapshots. Do not overwrite history.
- Predictions must be evaluated out-of-sample; never use future information in features.

## First deployment checklist

1. Create Neon project and run `rust-engine/migrations/0001_init.sql`.
2. Set secrets in the Rust host.
3. Deploy Rust service to a host with persistent network access.
4. Confirm `/health/db`.
5. Run one collection cycle and inspect `collection_runs`, `source_health`, `raw_snapshots`.
6. Confirm GT responses are genuine HTTP 200, not proxy-generated error payloads.
7. Deploy Worker and configure its secrets.
8. Check `/api/health` on the Worker.
9. Add entity mappings only after manually verifying participant identity.
10. Collect history before enabling any prediction workflow.

## Included commands

```bash
cargo test
cargo run
```


## Cloudflare-native scheduled collection (migration 0002)

The existing `rusty` Worker now has a `scheduled()` handler and performs collection
directly using the existing `DATABASE_URL` secret. It does not require a second Worker,
a second database, or an Axum service for the cron path.

Before deploying this revision, apply the additive migration:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f rust-engine/migrations/0002_worker_collection.sql
```

Then from `cloudflare/`:

```bash
npm install
npm test
npx tsc --noEmit
npx wrangler deploy
```

The existing `*/5 * * * *` trigger is retained. Set `ADMIN_TOKEN` only if you want
the authenticated manual endpoint `/api/v1/collection/run`; use
`npx wrangler secret put ADMIN_TOKEN`. Never expose this token in a browser.

The Worker polls the known eAdriatic season, the GT active-season and fixture APIs,
and Betika's current matches feed. GT stops on access restrictions and does not
attempt to bypass them. eAdriatic standings and Betika odds are stored as observations.
The lock is a database lease; it prevents ordinary overlapping cron invocations.

**Known scope limitations:** eAdriatic historical season discovery is not yet automatic;
the known season is collected and additional verified season IDs can be registered
as `entity_mappings` with `entity_type='eal_season'`. GT sport filtering depends on
the upstream response exposing a soccer label. GT standings/player-form/head-to-head
and detailed fixture APIs have not yet been wired. The player and head-to-head API
routes explicitly avoid pretending that fixture participant names are verified player
identities. Betika history is only available from the snapshots collected after deployment;
the current matches endpoint is not treated as a historical-results API.

## Odds-free prediction engine (experimental shadow mode)

Apply `rust-engine/migrations/0003_prediction_engine.sql` after migrations 0001 and 0002. The Worker exposes:

- `GET /api/v1/predictions?limit=30` — upcoming fixtures with experimental, odds-free model forecasts; optionally filter with `&source=betika`, `eadriatic`, or `gt`.
- `GET /api/v1/predict` — alias for the same endpoint.
- `GET /api/v1/predictions/performance` — settled walk-forward forecast record (accuracy and multiclass Brier score).

The first experimental ensemble combines a recency-weighted Elo rating with a score-distribution model using historical goals for/against and shrinkage toward competition averages. It reads fixture results only; it never queries or uses `odds_observations`. A forecast is withheld when the exact source/competition history has fewer than 12 matches for the two participants. The current version is deliberately marked `SHADOW_ONLY_UNVALIDATED` or `PASS_*`; do not use it as a betting recommendation. Its probability outputs are model estimates, not accuracy percentages. `evidence_strength_score` measures sample support, not chance of winning.

Before promoting a model to actionable status, build and pass chronological walk-forward tests on the actual eAdriatic and GT datasets, compare against simple baselines, report accuracy plus log loss/Brier score and calibration by probability bucket, and retain a truly untouched final test period. The present production sources do not yet provide reliable eAdriatic/GT histories (eAdriatic previously returned a schema error; GT returned HTTP 451), so this patch must not claim a validated 99.999% success rate. Betika may supply fixture names/scores for its competitions, but its odds are excluded from every prediction feature.

## Rusty intelligence foundation (migration 0004)

Apply `rust-engine/migrations/0004_intelligence_foundation.sql` after migrations 0001-0003. It is additive and preserves existing production rows. It creates source-scoped player/team participation history, player-team relationship history, model registry, backtest records, and prediction feature snapshots.

New endpoints:
- `GET /api/v1/intelligence/status` — data coverage and model registry status.
- `GET /api/v1/players` — only source-identified players observed in GT participant payloads.
- `GET /api/v1/players/:source_player_id?source=gt` — observed appearances, confirmed starts, unknown start status, and team associations.

GT collection now records player/team relationships only when the upstream fixture explicitly provides player IDs and team IDs. Starter status and position are nullable and remain unknown unless the source explicitly supplies them. Names are never used to merge identities across sources. The prediction response now includes last-ten form, head-to-head summary, and player/team pairing evidence where verified IDs and history exist. These player/team observations are currently explanatory evidence, not a model weight; they must pass independent walk-forward ablation tests before they influence forecast probabilities.

Predictions remain odds-free and shadow-only. `probabilities` are model estimates, not accuracy percentages. `evidence_strength_score` is not a probability. The system must not promote a model based on hit rate alone: promotion requires adequate sample size, improvement over simple baselines on chronological holdouts, acceptable Brier score/log loss, calibration checks, and stable performance across source/competition/time segments. No 99.999% accuracy is promised.

### Required next data capabilities

The existing upstream feeds do not yet guarantee complete player lineups, confirmed starters, per-player in-game actions, controller/formation settings, or match-state telemetry. The new schema preserves explicit participant data when present, but does not fabricate missing fields. Those signals can only become model inputs after a lawful, stable source supplies them and their timestamps prove they were known before kickoff. GT HTTP 451 and LeagueRepublic 429 must continue to be respected; do not bypass access controls or rate limits.
