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
