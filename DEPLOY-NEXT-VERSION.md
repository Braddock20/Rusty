# Deploy Rusty 0.2.1

This is a clean Cloudflare Worker release. It preserves all existing fixtures, raw snapshots, observations and forecasts. It adds a release identifier and safe database/schema diagnostics so the API and scheduled collector can be checked against the same Neon database. Collection now stops before calling providers if the required `fixtures.kickoff_at` column is missing, and reports the exact migration to apply.

## 1. Confirm the database schema

The Worker requires migrations 0001–0007. If your database is already on 0007, do not re-run older migrations. For an existing database missing only the canonical kickoff column, apply the additive migration once using the same Neon connection string configured as the Worker's `DATABASE_URL`:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f cloudflare/migrations/0007_canonical_kickoff.sql
```

This migration only adds/backfills `kickoff_at` and indexes; it does not delete or rewrite fixture history. Back up Neon before schema changes.

## 2. Install and deploy

From the `cloudflare/` directory, with Node.js 22.6+:

```bash
npm ci
npm test
npm run typecheck
npx wrangler deploy
```

Keep the existing Worker name, cron trigger and `DATABASE_URL` secret. Do not deploy the Rust service as a second collector. Do not paste database URLs or Cloudflare tokens into chat.

## 3. Verify the deployed Worker

Open `/api/v1/health`. A correct deployment reports `release: "0.2.1"` and a `schema` object with `has_kickoff_at: true`. `/api/v1/collection/status` reports the same release and database/schema diagnostics. These details contain database/schema names and the database role, but never the connection string.

After the next scheduled run, check `/api/v1/sources` and `/api/v1/collection/status`. A successful provider must have a new `last_success_at`. A `partial` run is acceptable only when its source summary clearly identifies which providers completed and which were budget-limited or unavailable. A 429 cooldown must be respected; do not manually hammer the eAdriatic endpoint.

`/api/v1/fixtures/upcoming` can remain empty when there are no verified future fixtures. Predictions intentionally abstain in that case. Historical eAdriatic statuses such as `Normal` or `Normal / Scheduled` are not silently reclassified as completed.

## Local validation boundary

`npm test` runs the 20 dependency-free unit tests. `npm run test:all` includes the database-backed integration suite; use only a disposable PostgreSQL database because the suite truncates its tables. Typecheck and Wrangler dry-run require the dependencies installed by `npm ci`. This workspace could not complete dependency installation due a package-registry timeout, so full typecheck, integration tests, Wrangler dry-run and production deployment remain unverified here.
