# Deploy Rusty 0.2.2

This release fixes collection lease renewal. The scheduled collector now extends its lease and updates `collection_runs.heartbeat_at` synchronously at every progress checkpoint, rather than relying on a background timer that may be suspended in a scheduled Worker isolate. A run that stops making progress will still lose its lease; a run that is progressing will refresh it.

From the `cloudflare` directory:

```sh
npm ci
npm test
npm run typecheck
npx wrangler deploy
```

Verify `/api/v1/health` reports `release: \"0.2.2\"`, then verify `/api/v1/collection/status` shows a recent `heartbeat_at` that advances during collection. Do not start a second manual collection while a scheduled run is active.
