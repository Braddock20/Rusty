# Production hardening release

See `PRODUCTION-HARDENING-REPORT.md` for scope, all changes, validation evidence, limitations and deployment steps.

## Main code changes
- Atomic lock + run creation, independent heartbeat, ownership checks and bounded run duration.
- Sequential, isolated provider collection; stale-run recovery uses heartbeat age.
- Provider-specific empty/malformed JSON errors, bounded transient retry and respectful 429/451 handling.
- Durable GT and Betika pagination checkpoints.
- Source-health attempt/record/error diagnostics.
- Explicit fixture completion classification and strict `/results`/prediction history filters.
- Explicit team IDs only for team form, H2H and rating history; no name-only identity joins.
- Correct recent-form ordering, shadow model registry entry, immutable forecast claims and guarded prediction outputs.
- Bounded API query parameters, 404/400/405 responses and generic public internal errors.
- Additive Neon migration `0006_production_hardening.sql`.

## Validation
- 12 Node tests passed.
- Worker TypeScript syntax checks passed.
- Strict TypeScript check passed with temporary ambient package declarations. Full dependency-backed typecheck and Wrangler build must be run after `npm install` in the deployment environment.
- No live Neon migration, Worker deployment or upstream API calls were made by this patch process.
