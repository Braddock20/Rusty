# Defect Fix Report — Rusty eSoccer Intelligence Engine

This report lists the defects that were reproduced and fixed during this pass. Every
finding below was confirmed either against a live PostgreSQL database running the
project migrations, or against the live upstream provider APIs.

The Cloudflare Worker is the active production path. The Rust service remains
experimental; it was not deployed and must not run as a second writer against the same
database.

## How the defects were found

The shipped test suite (12 tests) only exercised pure helper functions. `src/index.ts`
and `src/prediction.ts` were **not loadable under Node at all**, because they used
extensionless relative imports (`from "./normalize"`). The two files that contained
the actual collection, API and prediction logic were therefore never executed by any
test.

Two changes made the code testable:

1. Relative imports now carry an explicit `.ts` extension, and `tsconfig.json` sets
   `allowImportingTsExtensions` + `noEmit`. The Worker still bundles unchanged
   (`wrangler deploy --dry-run` → 265.58 KiB).
2. A Neon-SQL-compatible shim was added under `cloudflare/test/helpers/`. It speaks the
   same HTTP `/sql` protocol as `@neondatabase/serverless` (raw-text output, array mode,
   `{"queries":[...]}` batches) and is backed by a real PostgreSQL instance. The
   **unmodified** Worker therefore runs against a real database in tests.

Result: 37 tests (19 unit + 18 integration), 0 failures.

## Critical defects

### 1. The collector never ran at all — lease acquisition was broken
`collection_lock.run_id` was linked with a data-modifying CTE:

```sql
WITH lease AS (INSERT INTO collection_lock ... ON CONFLICT DO UPDATE ... RETURNING lock_name),
     created AS (INSERT INTO collection_runs ... FROM lease RETURNING id)
UPDATE collection_lock l SET run_id = c.id FROM created c
WHERE l.lock_name='scheduled' AND l.owner_token = ${ownerToken}
```

In PostgreSQL a data-modifying CTE's write is **not visible to the main query of the
same statement**; the main query reads the statement snapshot, in which `owner_token`
is still `NULL`. The final `UPDATE` therefore matched zero rows.

Reproduced verbatim in `psql`: the lease row was written with `run_id = NULL`, a
`collection_runs` row was created in status `running`, and the statement returned 0 rows.

Consequences, all confirmed by test:

- `acquired.length === 0` → every collection returned `skipped: "collection already running"`. **Nothing was ever collected.**
- The lease was never released (the release statement matches on `run_id`), so the lock stayed held for its full 3 minutes.
- `source_health` was never written: the ownership check in `sourceRun` matches on `run_id`, so it never found the owner.
- Every run row stayed in status `running` forever.

**Fix:** acquire the lease, create the run and link `run_id` in one real transaction
(`sql.transaction([...])`), so the second statement sees the first statement's writes.

### 2. Every list endpoint returned exactly one row
`safeInt(null, 50, 1, 200)` returned `1`, not `50`: `Number(null)` is `0`, which is
finite, so the fallback was never used. With no `?limit=` parameter, `/api/v1/fixtures`
returned 1 of 50 rows, `/api/v1/predictions` 1 of 30, `/api/v1/runs` 1 of 25.

**Fix:** a missing or blank parameter now returns the documented default; out-of-range
values are still clamped.

### 3. GT ingested zero fixtures
`isSoccerCompetition` tested `sport.name` against `/e.?soccer/i`. The live API names its
football sports `FIFA20`, `FIFA21`, `FIFA22`, `FIFA23` and `FC25`, and tags them
`tagId: "soccer"`; `NBA 2k21` is tagged `basketball`. The name test rejected **every**
GT fixture, and the source then reported success with 0 records.

A second latent bug hid behind it: `sport.name ?? category.name` short-circuited, so the
category name (`GT E-Sports G26`) was never consulted.

**Fix:** the soccer decision is taken from the authoritative `tagId` list fetched from
`/api/sports`, with the football sport names as a fallback, and NBA/basketball is
explicitly rejected.

### 4. GT results were never recognised as completed
GT exposes fixture status as a **numeric enum** (`0 not_started, 1 live, 2 suspended,
3 ended, 4 cancelled, 5 postponed, 6 forfeit, 10 unknown`) — the live payload is
`"status":3`. `classifyResultState` only matched English labels, so every GT fixture
stayed `unknown`: `/api/v1/results` was permanently empty for GT and no GT match could
ever enter the prediction history.

**Fix:** the numeric enum is mapped explicitly for GT. Unmapped codes stay `unknown`.

### 5. eAdriatic kickoff was unusable
LeagueRepublic publishes `fixtureDate` as a timezone-less local string
(`"20260916 07:00"`) alongside an unambiguous `fixtureDateInMilliseconds`. The
collector preferred the local string, so every eAdriatic fixture had an unparseable
kickoff and could never become a forecast candidate.

**Fix:** the epoch-milliseconds field is preferred. The ambiguous string is still
rejected by `parseTimestamp` if it is ever the only value available.

### 6. eAdriatic participant ids were never captured
LeagueRepublic carries the participant id as a **scalar** `homeTeam` / `roadTeam` value
(`928278216`), not as a nested object. The collector only looked for a nested
`{teamID, teamId, id}` object, so `home_team_external_id` was always `NULL`. With no
identity, the prediction engine could never reach its 12-match threshold for an
eAdriatic team and always answered `PASS_INSUFFICIENT_VERIFIED_HISTORY`.

**Fix:** scalar and nested id shapes are both handled.

### 7. eAdriatic standings were silently dropped
`standings` is a single object upstream (`{standingsDesc, standingsLines}`), but the
collector iterated it with `Array.isArray`, so the loop never ran and
`/api/v1/standings` was always empty. The group name was also read from
`fixtureGroupName`, while the API publishes `fixtureGroupDesc`.

**Fix:** both the object and array shapes are handled, and the real group name is used.

### 8. A non-numeric score returned HTTP 500
The settlement statement compared `f.home_score_raw::numeric` directly. PostgreSQL is
free to evaluate that cast before the `~ '^[0-9]+$'` guard in the same `WHERE` clause,
and a provider score such as `2-1` raises `invalid input syntax for type numeric`.

**Fix:** the cast is moved into a `CASE` that tests the regular expression first, so the
conversion can never be reached with a non-numeric value.

## Logic defects

### 9. The Elo away rating moved the wrong way
```rust
ratings.set(at, ar - k * ((1.0 - actual) - (1.0 - expected)));   // before
ratings.set(at, ar + k * ((1.0 - actual) - (1.0 - expected)));   // after
```
The home rating was updated with `k*(actual-expected)` and the away rating with the
negative of that expression, which is the *same* direction. When the home team won,
**both** teams gained Elo points. The away update is now `k*((1-actual)-(1-expected))`,
i.e. `k*(actual_away - expected_away)`.

### 10. The Rust collectors ingested nothing and swallowed write errors
The legacy Rust service was out of scope for the hardening release, but it contained
the same class of silent-failure bugs and was fixed on the same principles:

- eAdriatic fixtures live under `fixtureGroupList[].fixtures[]`; the flat top-level
  record walk returned an empty list, so **no** eAdriatic row was ever inserted.
- `homeTeam` (a number) was preferred over `homeTeamName`, so team names were stored
  as `"928278216"`.
- GT rows were never filtered by sport, so basketball fixtures were collected; and the
  nested participant and score fields were read with flat keys, so names and scores
  were always `NULL`.
- Database write failures were discarded with `let _ = db::save_fixture(...)`, so a
  failed write was invisible.
- `db::migrate` applied only migration 0001, so a database set up by the Rust service
  alone lacked the columns the rest of the system expects. It now applies 0001–0006,
  all of which are idempotent.
- The Rust service had no tests at all. Five unit tests now cover the nested
  LeagueRepublic fixture shape, the string-only team-name lookup, the GT football
  filter, the nested GT participant/score extraction and the flat record walk.

The Rust service remains experimental. It still has no collection lease of its own, so
it must not be run against the same database as the Worker; the Worker remains the
production collector.

### 11. The migration set could not be applied twice
Migration 0001 defined `latest_score` with six columns and used `CREATE OR REPLACE VIEW`.
Migration 0002 redefined the same view with seven (it added `id`). PostgreSQL cannot drop
columns through `CREATE OR REPLACE VIEW`, so applying 0001 after 0002 failed with
`cannot drop columns from view`. Any environment that re-applied the migration set — for
example the Rust service, which migrates on every start — would fail to boot the second
time.

**Fix:** migration 0001 now drops and recreates the views and declares the same columns
as 0002, so the full set is idempotent in any order. Verified by applying 0001–0006
three times in a row with no error and an unchanged view definition.

## Test-harness fidelity notes

These are not product defects, but they are recorded because they change what the tests
actually prove.

- The Neon driver parses timestamp columns with the **PostgreSQL wire format**
  (`2026-11-03 20:44:04.540000+00`). The shim originally emitted ISO-8601, which the
  driver silently resolved to `null` — every timestamp in the API came back empty while
  the database was correct. The shim now emits the PostgreSQL format, matching what a
  real Neon server sends.
- The integration suite reads the database through `pg` directly, so it did not exercise
  the driver's type conversion. The HTTP smoke test does, and it is what caught the
  timestamp problem above.

## Behaviour deliberately left unchanged

- **eAdriatic completion is still not inferred from scores.** The live match hub reports
  historical fixtures as `Normal / Scheduled` with scores already present, and the
  provider publishes no terminal label. Treating `result: true` or the presence of
  scores as completion would contradict the project's stated policy ("approval flags or
  scores alone are insufficient") and would backfill the 212 recovered fixtures as
  results. They remain `scheduled` / `unknown` until the provider emits an explicit
  terminal status.
- **No provider access restriction is bypassed.** HTTP 451 on GT and HTTP 429 on
  eAdriatic are still respected and recorded.
- **Betika remains a score-free feed.** The live payload has no `status` and no
  `home_score` / `away_score`; its odds are still excluded from every model input.
- **Betika's timezone is not guessed.** `start_time` is a local clock string. The
  Worker now accepts an explicit `BETIKA_UTC_OFFSET_MINUTES` setting (180 = UTC+3,
  the provider's published East Africa Time) and rejects the string when the setting
  is absent, exactly as before.

## Verification performed

| Check | Result |
| --- | --- |
| `npm test` with a database | 37 passed, 0 failed, 0 skipped |
| `npm test` without a database | 19 passed, 18 skipped (integration tests need `DATABASE_URL`) |
| `npx tsc --noEmit` | clean |
| `npx wrangler deploy --dry-run` | bundles, 265.58 KiB / gzip 69.95 KiB |
| Migrations 0001–0006 on PostgreSQL 15 | applied cleanly |
| Live upstream calls | eAdriatic, GT and Betika responses verified against the real payloads |
| `cargo test` (rust-engine) | 5 passed, 0 failed; `cargo build` clean (2 dead-code warnings for the unused `EngineError` enum) |
| Rust service boot smoke test | boots against PostgreSQL, applies all 18 relations, serves `/health`, `/health/db` and `/api/v1/fixtures`, rejects an unauthorized `POST /internal/collect` with 401 |
| Migrations 0001–0006 applied three times consecutively | no errors, view definitions stable |
| `scripts/test-local.sh` (mock providers) | 37 tests + 20/20 smoke checks pass |
| `scripts/test-local.sh --live` (real upstream APIs) | 37 tests + 20/20 smoke checks pass |

### Live collection result

A full collection against the **real** upstream APIs, writing to a local PostgreSQL
database, produced:

| source | fixtures | completed | with team ids | usable kickoff |
| --- | --- | --- | --- | --- |
| gt | 1000 | 1000 | 1000 | ISO, already usable |
| eadriatic | 212 | 0 | 212 | 212 epoch timestamps |
| betika | 22 | 0 | 0 | 0 (timezone-less, correctly rejected) |

Plus 86 standings rows, 2000 player-participation rows, 66 odds observations and 3
pagination checkpoints.

Before the fixes the same run produced **zero** GT fixtures (the sport filter rejected
every one), zero eAdriatic team ids, zero usable eAdriatic kickoffs and zero standings
rows. The 212 eAdriatic fixtures remain `scheduled`/`unknown` rather than completed,
because that provider publishes no terminal status — see below.

The integration suite asserts the fixed behaviour directly: the run reaches a terminal
state, the lease is released and linked, all three providers are recorded in
`source_health`, GT and eAdriatic fixtures are ingested and classified, standings are
collected, checkpoints persist, list endpoints honour their defaults, and a non-numeric
score does not crash the prediction endpoints.

The rewritten lease was additionally verified under concurrency: three simultaneous
collections produce exactly one run, no run is left in `running`, and a lease held by
another owner blocks a second collection without being overwritten.

### Test tooling added

| File | Purpose |
| --- | --- |
| `cloudflare/test/helpers/neon-shim.ts` | Neon HTTP `/sql` protocol on top of PostgreSQL, so the unmodified Worker runs in tests without a Neon account |
| `cloudflare/test/helpers/provider-fixtures.ts` | Deterministic upstream payloads that mirror the real API shapes |
| `cloudflare/test/worker.integration.test.ts` | 18 integration tests driving the real Worker over the real database |
| `cloudflare/test/smoke.ts` | HTTP smoke test for any deployed instance; `--trigger` runs a real collection and verifies the outcome |
| `scripts/local-server.ts` | Boots the Worker locally against a plain PostgreSQL database |
| `scripts/test-local.sh` | One command: provision database, migrate, test, boot, smoke test |
