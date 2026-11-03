RUSTY eSOCCER — COLLECTION STATUS ROUTE FIX

This is a small correction to the consolidated hotfix. The previous hotfix
accidentally routed both /api/v1/sources and /api/v1/collection/status to the
source-health response. This patch separates those routes.

FILES
- cloudflare/src/index.ts

BEHAVIOR
- /api/v1/sources returns the configured provider-health rows.
- /api/v1/collection/status returns the scheduled collection lock (including
  whether it is currently locked) and the five most recent collection runs.

No database migration is required. No existing data is modified.

DEPLOY
Replace cloudflare/src/index.ts in the existing Worker project with the
included file and deploy normally using the existing Wrangler configuration.

VERIFY
Open /api/v1/collection/status. Expected top-level keys are "lock" and
"recent_runs", not "sources".
