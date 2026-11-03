/**
 * Deployment smoke test.
 *
 * Validates a running Rusty instance (local server or deployed Worker) against the
 * invariants that the fixed defects used to break. It is a read-only check by default;
 * pass --admin-token to also trigger a real collection run.
 *
 *   node --experimental-strip-types test/smoke.ts https://your-worker.workers.dev \
 *     [--admin-token=secret] [--trigger]
 *
 * Exit code 0 means every check passed.
 */
const args = process.argv.slice(2);
const baseUrl = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/$/, "");
const adminToken = args.find((a) => a.startsWith("--admin-token="))?.split("=")[1];
const trigger = args.includes("--trigger");

export {};

if (!baseUrl) {
  console.error("usage: node --experimental-strip-types test/smoke.ts <baseUrl> [--admin-token=X] [--trigger]");
  process.exit(2);
}

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

console.log(`\nRusty smoke test → ${baseUrl}\n`);

// 1. Health -----------------------------------------------------------------
{
  const { status, body } = await get("/api/v1/health");
  record(
    "GET /api/v1/health",
    status === 200 && body?.ok === true && body?.database === "connected",
    `status=${status} database=${body?.database ?? "?"}`,
  );
}

// 2. Optional live collection (runs first so the data checks below see its results)
if (trigger) {
  if (!adminToken) {
    record("live collection run", false, "--trigger needs --admin-token");
  } else {
    const response = await fetch(`${baseUrl}/api/v1/collection/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
      signal: AbortSignal.timeout(300_000),
    });
    const body: any = await response.json().catch(() => null);
    record(
      "POST /api/v1/collection/run triggers a collection",
      response.status === 200 && body?.run_id !== undefined,
      `status=${response.status} run_id=${body?.run_id ?? "?"} outcome=${JSON.stringify(body?.status ?? body?.reason ?? "")}`,
    );

    const status = await get("/api/v1/collection/status");
    const lock = status.body?.lock;
    record(
      "the lease is released after the run",
      !lock?.is_locked && !lock?.owner_token,
      `is_locked=${lock?.is_locked} owner=${lock?.owner_token ?? "none"}`,
    );

    const runs = await get("/api/v1/runs?limit=1");
    const latest = runs.body?.runs?.[0];
    record(
      "the run reached a terminal status",
      !!latest && ["success", "partial", "failed"].includes(latest.status) && !!latest.finished_at,
      `status=${latest?.status ?? "?"} finished_at=${latest?.finished_at ?? "missing"}`,
    );

    const sources = await get("/api/v1/sources");
    const attempted = (sources.body?.sources ?? []).filter((s: any) => s.last_attempt_at).length;
    record(
      "provider health was recorded for the attempted sources",
      attempted > 0,
      `sources attempted=${attempted}/3`,
    );
  }
}

// 3. Sources ----------------------------------------------------------------
{
  const { status, body } = await get("/api/v1/sources");
  const names = Array.isArray(body?.sources) ? body.sources.map((s: any) => s.source).sort() : [];
  const expected = ["betika", "eadriatic", "gt"];
  record(
    "GET /api/v1/sources lists all three providers",
    status === 200 && JSON.stringify(names) === JSON.stringify(expected),
    `sources=${JSON.stringify(names)}`,
  );
}

// 3. Collection status ------------------------------------------------------
{
  const { status, body } = await get("/api/v1/collection/status");
  const hasLock = body?.lock !== undefined;
  const hasRuns = Array.isArray(body?.recent_runs);
  const hasCheckpoints = Array.isArray(body?.checkpoints);
  record(
    "GET /api/v1/collection/status returns lock, runs and checkpoints",
    status === 200 && hasLock && hasRuns && hasCheckpoints,
    `lock=${body?.lock ? "present" : "missing"} runs=${body?.recent_runs?.length ?? "?"} checkpoints=${body?.checkpoints?.length ?? "?"}`,
  );
}

// 4. Runs -------------------------------------------------------------------
{
  const { status, body } = await get("/api/v1/runs?limit=5");
  const runs = Array.isArray(body?.runs) ? body.runs : [];
  const stuck = runs.filter((r: any) => r.status === "running");
  record(
    "GET /api/v1/runs returns history with no run stuck in 'running'",
    status === 200 && runs.length > 0 && stuck.length === 0,
    `runs=${runs.length} statuses=${JSON.stringify(runs.map((r: any) => r.status))}`,
  );
}

// 5. Fixtures ---------------------------------------------------------------
{
  const { status, body } = await get("/api/v1/fixtures");
  const fixtures = Array.isArray(body?.fixtures) ? body.fixtures : [];
  const withState = fixtures.filter((f: any) => typeof f.result_state === "string").length;
  record(
    "GET /api/v1/fixtures honours its default limit (regression: limit=1)",
    status === 200 && body?.limit === 50 && fixtures.length > 1,
    `limit=${body?.limit} returned=${fixtures.length}`,
  );
  record(
    "GET /api/v1/fixtures rows carry an explicit result_state",
    status === 200 && fixtures.length > 0 && withState === fixtures.length,
    `${withState}/${fixtures.length} rows have result_state`,
  );
}

// 6. Results ----------------------------------------------------------------
{
  const { status, body } = await get("/api/v1/results");
  const rows = Array.isArray(body?.fixtures) ? body.fixtures : [];
  const invalid = rows.filter(
    (f: any) =>
      f.result_state !== "completed" ||
      !/^[0-9]+$/.test(String(f.home_score_raw ?? "")) ||
      !/^[0-9]+$/.test(String(f.away_score_raw ?? "")),
  );
  record(
    "GET /api/v1/results contains only completed fixtures with numeric scores",
    status === 200 && invalid.length === 0,
    `rows=${rows.length} invalid=${invalid.length}`,
  );
}

// 7. Predictions ------------------------------------------------------------
{
  const { status, body } = await get("/api/v1/predictions");
  record(
    "GET /api/v1/predictions responds and stays odds-free",
    status === 200 && body?.odds_used === false,
    `status=${status} odds_used=${body?.odds_used} count=${body?.count ?? "?"}`,
  );
}

// 8. Performance ------------------------------------------------------------
{
  const { status, body } = await get("/api/v1/predictions/performance");
  record(
    "GET /api/v1/predictions/performance responds",
    status === 200 && Array.isArray(body?.performance),
    `status=${status} models=${body?.performance?.length ?? "?"}`,
  );
}

// 9. Supporting endpoints ---------------------------------------------------
for (const path of [
  "/api/v1/standings",
  "/api/v1/odds",
  "/api/v1/intelligence/status",
  "/api/v1/players",
  "/api/v1/collection/run",
]) {
  const { status } = await get(path);
  const expected = path === "/api/v1/collection/run" ? 405 : 200;
  record(`GET ${path}`, status === expected, `status=${status} (expected ${expected})`);
}

// 10. Error handling --------------------------------------------------------
{
  const missing = await get("/api/v1/does-not-exist");
  record("unknown path returns 404", missing.status === 404, `status=${missing.status}`);

  const badId = await get("/api/v1/fixtures/%E0%A4%A");
  record("malformed fixture id returns 400", badId.status === 400, `status=${badId.status}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log("\nFailed checks:");
  for (const check of failed) console.log(`  - ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
}
process.exit(failed.length ? 1 : 0);
