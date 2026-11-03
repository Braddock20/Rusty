# Deploy Rusty 0.2.0

This release adds canonical fixture kickoff timestamps. The migration is additive and preserves all existing rows.

## Before deployment

1. Take a Neon backup or snapshot.
2. Confirm the database already has migrations 0001–0006. This release does not ask you to reapply them.
3. Apply exactly one new migration in the Neon SQL editor or with `psql`:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f rust-engine/migrations/0007_canonical_kickoff.sql
```

4. Deploy the contents of `cloudflare/` to the existing Cloudflare Worker. Keep the existing `DATABASE_URL`, cron trigger and secrets. Do not deploy the Rust service as a second collector.

## After deployment

Check these endpoints when convenient:

- `/api/v1/health` — database connectivity.
- `/api/v1/collection/status` — lock/run linkage and heartbeat diagnostics. The owner token is no longer exposed.
- `/api/v1/fixtures/upcoming` — only timezone-aware future fixtures.
- `/api/v1/results` — only explicitly completed fixtures with valid numeric scores.
- `/api/v1/predictions?limit=20` — shadow predictions, if sufficient verified data and upcoming fixtures exist.

A `partial` collection can be a valid bounded run when the time budget is reached. Durable provider cursors should continue on later scheduled runs; it must not be represented as a complete provider crawl until its cursor cycle finishes.

## Local validation

From `cloudflare/`:

```bash
npm ci
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

For database-backed integration tests, set `DATABASE_URL` to a disposable PostgreSQL database and run `scripts/test-local.sh --db="$DATABASE_URL"`. Never point destructive test setup at production: the integration suite truncates its test tables.

## Important validation boundary

This package was syntax-checked and its 20 dependency-free unit tests passed in the build workspace. Full integration tests, TypeScript typecheck, Rust compilation, migration execution against PostgreSQL, Cloudflare dry-run and production deployment could not be run here because this workspace did not have a reachable dependency install, PostgreSQL client/server, Cargo toolchain, or production credentials. Do not interpret this artifact as already deployed or production-verified.
