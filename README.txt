RUSTY eSOCCER — PERFORMANCE ENDPOINT HOTFIX

Problem:
GET /api/v1/predictions/performance failed with:
function round(double precision, integer) does not exist

Fix:
The Brier-score AVG expression is explicitly cast to numeric before round(..., 5).

File to replace in the deployed Cloudflare Worker project:
cloudflare/src/index.ts

Deploy from the cloudflare project directory using your normal Wrangler deployment command.
Then retest:
https://rusty.talesapi.workers.dev/api/v1/predictions/performance

Expected behavior:
The endpoint should return JSON with a performance array (possibly empty if no forecasts have been settled), plus the explanatory note. An empty array is valid; it means there is not yet a settled forecast history to score.

No database migration is required. No historical data is deleted or modified by this code change. The existing endpoint's settlement UPDATE remains unchanged.
