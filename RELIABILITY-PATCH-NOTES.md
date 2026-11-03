# Collection reliability patch

## What changed
- Adds `collection_lock.owner_token` so only the worker that acquired a lease can renew or release it.
- Extends the lease to 10 minutes and renews it at collector/page/fixture checkpoints.
- Adds `source_health.cooldown_until`; HTTP 429 `Retry-After` values are persisted and the affected source is skipped until its cooldown expires.
- Successful source runs clear the cooldown and reset consecutive failures.
- Finalization updates only rows still marked `running`; stale recovery remains a failure, never a fabricated success.

## Apply and deploy
1. Apply `rust-engine/migrations/0005_collection_reliability.sql` to the existing Neon database.
2. Deploy the updated `cloudflare` Worker using the existing Wrangler environment and secrets.
3. Trigger one authorized collection run, then inspect `/api/v1/runs?limit=5` and `/api/v1/sources`.

## Important limitations
- This patch does not bypass upstream access restrictions or attempt to evade HTTP 429. It honors the returned retry delay.
- It does not replay or re-fetch historical data. The 212-fixture eAdriatic recovery already verified in Neon remains intact.
- Renewal occurs at work checkpoints. A single upstream request is bounded by the existing 18-second timeout.
- `Promise.all` still allows independent source collectors to run concurrently; each reports its own success/failure.

## Verification
After deployment, verify: a terminal run status with `finished_at`; the lock has `locked_until <= now()` and `owner_token IS NULL`; and source health shows either a recent success or a persisted cooldown/error.
