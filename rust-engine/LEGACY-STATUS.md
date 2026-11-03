# Rust service status — not the active production collector

The current production path is the Cloudflare Worker. This Rust service was not compiled or modified in the production-hardening release and must not be scheduled as a second collector against the same Neon database.

A separate Rust hardening pass is required before enabling it. Code review identified the following outstanding issues in the legacy implementation:

- `db::migrate` currently executes only migration 0001, not the full ordered migration set.
- `/internal/collect` starts a run without acquiring the shared collection lease; concurrent calls can overlap.
- The Rust GT collector ignores some `save_fixture` / `save_score` errors and can manufacture fallback fixture IDs from offsets rather than requiring provider IDs.
- The Rust GT collector's fixture path does not apply the Worker eSoccer competition filter consistently.
- The Rust Betika collector reads only page 1 and does not use the Worker pagination checkpoint.
- The Rust eAdriatic collector's generic `walk_records` traversal does not specifically flatten the `fixtureGroupList[].fixtures[]` structure used by the recovered Match Hub payload.
- Rust read API functions use `unwrap_or_default()` for database errors in some queries, which can make a database failure look like an empty result.
- It does not implement the Worker source-health, cooldown, result-state, forecast or checkpoint contracts.

These are intentionally called out rather than represented as fixed. Use the Cloudflare Worker as the only production collector until the Rust service receives its own tested migration, lock, parser, pagination and error-handling work.
