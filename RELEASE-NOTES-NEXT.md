# Rusty eSoccer — Next Version Engineering Notes

## Baseline

This release is built from the supplied `rusty-esoccer-production-hardening-FIXED-1.zip` project. It preserves the existing Cloudflare Worker + Neon architecture and does not switch the production writer to the experimental Rust service.

The operator-reported latest live run collected 200 GT fixtures and 212 eAdriatic fixtures, ending `partial` with a time-budget note. This is recorded as an operator-reported baseline, not independently verified from this workspace.

## Changes in this pass

- Added migration `0007_canonical_kickoff.sql` with a nullable `fixtures.kickoff_at TIMESTAMPTZ` field, safe backfill from eAdriatic `fixtureDateInMilliseconds`, epoch values and offset-bearing ISO timestamps, plus indexes for upcoming fixture queries.
- Kept `kickoff_raw` unchanged for provider auditability. Timezone-less strings are not assigned an invented timezone.
- Worker fixture upserts now populate `kickoff_at` when the provider gives an unambiguous timestamp and preserve a previously normalized value when a later payload omits one.
- Prediction candidate and historical-fixture processing now prefer `kickoff_at`; timestamp parsing also accepts JavaScript `Date` objects and numeric epoch values.
- Added `GET /api/v1/fixtures/upcoming`, which uses database time and canonical timestamps rather than lexical sorting of provider strings.
- Fixture list ordering now prefers canonical kickoff time.
- Collection status now reports whether an active lock has a matching recent run link and how many recent runs remain marked running.
- Added timestamp unit coverage and integration assertions for canonical eAdriatic kickoff storage.
- Updated the Rust migration list and local test script to include migration 0007. The Rust service remains experimental and must not run as a second production writer.

## Preserved safety rules

- Existing raw snapshots, fixtures, score observations and prediction history are not deleted.
- eAdriatic `Normal / Scheduled` and approval flags are not treated as completion.
- A numeric score alone does not settle a result.
- Unknown or timezone-less kickoff values remain excluded from upcoming forecasts.
- Provider-specific team identity remains source-scoped; no name-based cross-provider merging.
- Bookmaker odds remain excluded from prediction features.
- Predictions remain shadow-only until chronological backtesting and calibration establish performance.

## Verification status in this workspace

- Unit test command: 20 unit tests passed after the timestamp additions; rerun required after dependency installation.
- Full test command currently cannot complete because the uploaded environment's `node_modules` is incomplete (`pg` and `@cloudflare/workers-types` are absent). An `npm ci` attempt timed out in this workspace.
- TypeScript check is blocked by the missing `@cloudflare/workers-types` package.
- No Neon credentials or deployed Worker access were supplied, so migration 0007 and the updated Worker have not been applied to production or live-tested here.

These limitations are intentionally explicit; no deployment or production verification is claimed.
