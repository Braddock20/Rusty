RUSTY eSOCCER — CONSOLIDATED API + COLLECTION HOTFIX

This patch is based on the previously supplied performance hotfix. It preserves the existing
Neon schema and all collected data. No SQL migration is required.

FILES
- cloudflare/src/index.ts

FIXES
1. Prediction performance: retains the PostgreSQL numeric cast for the multiclass Brier score.
2. Results endpoint: /api/v1/results now returns only rows with numeric scores AND an explicit
   completion marker (finished, complete, final, played, or result). /api/v1/fixtures remains
   the unfiltered fixture feed. This intentionally avoids treating an approved/scheduled
   eAdriatic fixture with a score as a confirmed final result when the feed status is ambiguous.
3. Source health: /api/v1/sources and /api/v1/collection/status always show eadriatic, gt,
   and betika. A provider never contacted appears with NULL timestamps/error and zero failures.
4. Collection lock: extends the lease to 20 minutes and adds an independent 30-second heartbeat,
   while retaining owner-token checks. Abandoned run rows are reconciled only after 25 minutes
   and only after a new worker has acquired the lock. The lock is released only by its owner.

DEPLOY
Replace cloudflare/src/index.ts in the existing Worker project with this file, then deploy
from the cloudflare directory using the existing Wrangler deployment process.
No secrets, environment variables, cron settings, database schema, or historical rows need
changing.

POST-DEPLOY API CHECKS
- /api/v1/health
- /api/v1/sources
- /api/v1/results?source=eadriatic&limit=10
- /api/v1/fixtures?source=eadriatic&limit=5
- /api/v1/runs?limit=10
- /api/v1/predictions/performance

IMPORTANT DATA SEMANTICS
The recovered 212 eAdriatic rows are preserved. Their status currently appears as "Normal"
and/or "Normal / Scheduled" in the upstream payload. The stricter /results endpoint will not
classify them as completed unless the provider exposes an explicit completion marker. They
remain accessible from /fixtures. Do not relax this filter by assuming that a score or approval
flag proves a match is final.

This patch does not create historical Betika results, cross-map provider competitions, or claim
prediction accuracy. It also does not bypass upstream access restrictions or rate limits.
