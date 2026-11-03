# Worker hotfix notes

This patch addresses the confirmed production diagnostics without changing database schema or deleting existing records.

## Changes
- eAdriatic season lookup now selects `external_id_a AS external_id`, matching the existing `entity_mappings` schema.
- HTTP 429 is treated as a rate-limit response, reads `Retry-After` or `retry_after_seconds`, and stops retrying immediately. The next scheduled run can retry after the upstream window rather than hammering the API.
- Collection finalization now uses `try/catch/finally`: an unexpected failure marks the run failed, and the collection lock is released.
- On the next successful lock acquisition, runs older than 15 minutes still marked `running` are marked failed with a recovery summary.
- Lock expiry was extended to 15 minutes to reduce overlapping runs for the five-minute schedule.
- HTTP 401/403/451 behavior remains restrictive; no access-control bypass was added.

## Deploy
From `cloudflare/`:

```sh
npm test
npx wrangler deploy
```

After deployment, wait for the next cron run and inspect `/api/v1/runs?limit=5` and `/api/v1/sources`. The first new run should complete with `success`, `partial`, or `failed`, not remain `running`. eAdriatic may still report a 429 until LeagueRepublic's rate-limit window resets.

This archive has not been deployed to the live Worker and cannot verify Neon production state. The included tests validate the existing normalizers; they do not exercise live upstream APIs or Neon.
