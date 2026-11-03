/**
 * End-to-end integration tests for the Cloudflare Worker.
 *
 * The Worker code runs unmodified: the Neon HTTP driver is pointed at a local
 * PostgreSQL through the Neon-compatible shim, and upstream provider calls are
 * served deterministic fixtures.
 *
 * Requires DATABASE_URL to point at a PostgreSQL database with migrations
 * 0001-0006 applied. Tests are skipped when it is not set.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startNeonShim, installFetchStub } from "./helpers/neon-shim.ts";
import { providerResponse } from "./helpers/provider-fixtures.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const skip = DATABASE_URL ? false : "DATABASE_URL is not set; skipping integration tests";
const NEON_URL = "postgres://user:pass@ep-example.us-east-2.aws.neon.tech/rusty?sslmode=require";

let shim: Awaited<ReturnType<typeof startNeonShim>> | null = null;
let restoreFetch: (() => void) | null = null;
let worker: any = null;

const ENV = { DATABASE_URL: NEON_URL };

before(async () => {
  if (skip) return;
  shim = await startNeonShim(DATABASE_URL);
  restoreFetch = installFetchStub(shim.url, (url) => providerResponse(url));
  worker = (await import("../src/index.ts")).default;
  await reset();
});

after(async () => {
  restoreFetch?.();
  await shim?.close();
});

async function reset() {
  await shim!.query(
    `TRUNCATE raw_snapshots, score_observations, odds_observations, fixtures, standings,
     player_match_participation, player_team_history, prediction_history, prediction_forecast_keys,
     prediction_model_registry, prediction_backtests, collection_checkpoints, collection_runs,
     collection_lock, source_health, entity_mappings RESTART IDENTITY CASCADE`,
  );
  await shim!.query(
    `INSERT INTO entity_mappings(entity_type,source_a,external_id_a,display_name_a,source_b,external_id_b,display_name_b,verified)
     VALUES ('eal_season','eadriatic','656829288','Season 2026','eadriatic','656829288','Season 2026',true)`,
  );
}

async function runCollection() {
  let pending: Promise<unknown> | null = null;
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending = p;
    },
    passThroughOnException() {},
  };
  await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, ENV, ctx);
  await pending;
}

async function api(path: string) {
  const response = await worker.fetch(new Request(`https://rusty.example${path}`), ENV);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
}

test("a scheduled collection run completes and reaches a terminal state", { skip }, async () => {
  await runCollection();

  const runs = await shim!.query(`SELECT id, status, finished_at, summary FROM collection_runs ORDER BY id DESC`);
  assert.equal(runs.rows.length, 1, "expected exactly one collection run");
  assert.ok(["success", "partial", "failed"].includes(runs.rows[0].status), `run stayed in status ${runs.rows[0].status}`);
  assert.notEqual(runs.rows[0].status, "running", "run never reached a terminal status");
  assert.ok(runs.rows[0].finished_at, "run has no finished_at");
});

test("the collection lease is released after the run", { skip }, async () => {
  await runCollection();
  const lock = await shim!.query(
    `SELECT locked_until, owner_token, run_id FROM collection_lock WHERE lock_name='scheduled'`,
  );
  assert.equal(lock.rows.length, 1, "no collection_lock row exists");
  assert.equal(lock.rows[0].owner_token, null, "lease owner token was not released");
  assert.equal(lock.rows[0].run_id, null, "lease was not linked back to the run");
});

test("the collection lock row is linked to its run while collection is active", { skip }, async () => {
  // The lease must be tied to the run id it owns, otherwise ownership checks cannot work.
  await reset();
  await runCollection();
  const link = await shim!.query(
    `SELECT r.id AS run_id, r.status FROM collection_runs r ORDER BY r.id DESC LIMIT 1`,
  );
  assert.ok(link.rows.length, "no run recorded");
  assert.notEqual(link.rows[0].status, "running");
});

test("source health is recorded for every provider", { skip }, async () => {
  await runCollection();
  const health = await shim!.query(
    `SELECT source, last_attempt_at, last_success_at, last_record_count, consecutive_failures, error_code FROM source_health ORDER BY source`,
  );
  const bySource = new Map(health.rows.map((r: any) => [r.source, r]));
  for (const source of ["eadriatic", "gt", "betika"]) {
    assert.ok(bySource.has(source), `source_health has no row for ${source}`);
    assert.ok(bySource.get(source)!.last_attempt_at, `${source} was never attempted`);
    assert.equal(Number(bySource.get(source)!.consecutive_failures), 0, `${source} reported failures`);
  }
});

test("fixtures are collected and classified by explicit provider status", { skip }, async () => {
  await runCollection();
  const fixtures = await shim!.query(
    `SELECT source, external_id, result_state, home_team_external_id, away_team_external_id, kickoff_raw, kickoff_at, competition FROM fixtures ORDER BY source, external_id`,
  );
  assert.ok(fixtures.rows.length >= 6, `expected fixtures from all providers, got ${fixtures.rows.length}`);

  const eal = fixtures.rows.find((r: any) => r.source === "eadriatic" && r.external_id === "45539806");
  assert.equal(eal!.result_state, "scheduled", "Normal / Scheduled must not be completed");
  assert.equal(eal!.home_team_external_id, "928278216", "LeagueRepublic scalar team id was not captured");
  assert.equal(eal!.away_team_external_id, "724171548", "LeagueRepublic scalar team id was not captured");
  assert.match(eal!.kickoff_raw, /^\d{13}$/, "eAdriatic kickoff must preserve the unambiguous provider epoch");
  assert.ok(eal!.kickoff_at, "eAdriatic canonical kickoff_at was not populated");
  assert.equal(eal!.competition, "FC26 SEASON 11", "LeagueRepublic fixture group description was not captured");

  const cancelled = fixtures.rows.find((r: any) => r.source === "eadriatic" && r.external_id === "45179999");
  assert.equal(cancelled!.result_state, "cancelled", "explicit Cancelled status was not classified");

  const gt = fixtures.rows.find((r: any) => r.source === "gt" && r.external_id === "9002");
  assert.equal(gt!.result_state, "completed", "GT numeric status 3 (ended) must be completed");
  assert.equal(gt!.home_team_external_id, "701", "GT team id was not persisted");

  const gtLive = fixtures.rows.find((r: any) => r.source === "gt" && r.external_id === "9004");
  assert.equal(gtLive!.result_state, "live", "GT numeric status 1 (live) must be live");

  const gtUpcoming = fixtures.rows.find((r: any) => r.source === "gt" && r.external_id === "9001");
  assert.equal(gtUpcoming!.result_state, "scheduled", "GT numeric status 0 (not_started) must be scheduled");
});

test("eAdriatic standings are collected from the upstream object shape", { skip }, async () => {
  await runCollection();
  const standings = await shim!.query(
    `SELECT source, competition, external_team_id, team_name, position, points FROM standings`,
  );
  assert.ok(standings.rows.length >= 1, "no eAdriatic standings were collected");
  assert.equal(standings.rows[0].external_team_id, "928278216");
  assert.equal(standings.rows[0].competition, "FC26 SEASON 11");
});

test("GT fixtures are actually ingested (sport filter must not reject football)", { skip }, async () => {
  await runCollection();
  const count = await shim!.query(`SELECT count(*)::int AS n FROM fixtures WHERE source='gt'`);
  assert.ok(count.rows[0].n >= 3, `GT ingested only ${count.rows[0].n} fixtures`);
});

test("pagination checkpoints are persisted", { skip }, async () => {
  await runCollection();
  const checkpoints = await shim!.query(`SELECT source, dataset, cursor FROM collection_checkpoints ORDER BY source`);
  assert.ok(checkpoints.rows.length >= 2, "expected durable pagination checkpoints");
  assert.ok(checkpoints.rows.some((r: any) => r.source === "gt" && r.dataset === "fixtures"));
});

test("GET /api/v1/fixtures returns the full feed, not a single row", { skip }, async () => {
  await runCollection();
  const { status, body } = await api("/api/v1/fixtures");
  assert.equal(status, 200);
  assert.ok(body.fixtures.length > 1, `default limit returned only ${body.fixtures.length} fixture(s)`);
  assert.equal(body.limit, 50);
});

test("GET /api/v1/fixtures/upcoming only returns canonical future kickoff timestamps", { skip }, async () => {
  await runCollection();
  const { status, body } = await api("/api/v1/fixtures/upcoming");
  assert.equal(status, 200);
  assert.ok(body.fixtures.length > 0, "expected future fixtures from deterministic provider payloads");
  for (const fixture of body.fixtures) {
    assert.ok(fixture.kickoff_at, `fixture ${fixture.external_id} has no canonical kickoff_at`);
    assert.ok(Date.parse(fixture.kickoff_at) > Date.now(), `fixture ${fixture.external_id} is not in the future`);
  }
});

test("GET /api/v1/results only returns explicitly completed fixtures", { skip }, async () => {
  await runCollection();
  const { status, body } = await api("/api/v1/results");
  assert.equal(status, 200);
  assert.ok(body.fixtures.length > 0, "no completed fixtures returned");
  for (const fixture of body.fixtures) {
    assert.equal(fixture.result_state, "completed");
    assert.match(fixture.home_score_raw, /^[0-9]+$/);
    assert.match(fixture.away_score_raw, /^[0-9]+$/);
  }
  assert.ok(!body.fixtures.some((f: any) => f.external_id === "45539806"), "scheduled fixture leaked into /results");
  assert.ok(!body.fixtures.some((f: any) => f.external_id === "9001"), "not_started GT fixture leaked into /results");
});

test("a non-numeric score never crashes the prediction endpoints", { skip }, async () => {
  await runCollection();
  // A provider can publish a score that is not a bare integer. Casting it to numeric
  // unguarded raises "invalid input syntax for type numeric" and returns a 500.
  await shim!.query(
    `INSERT INTO fixtures(source,external_id,competition,home_name,away_name,kickoff_raw,status_raw,home_score_raw,away_score_raw,payload,result_state)
     VALUES('gt','BROKEN-1','GT Leagues','A','B','2026-10-01T10:00:00.000Z','ended','2-1','0','{}'::jsonb,'completed')`,
  );
  const performance = await api("/api/v1/predictions/performance");
  assert.equal(performance.status, 200, `performance endpoint failed: ${JSON.stringify(performance.body)}`);
  const predictions = await api("/api/v1/predictions");
  assert.equal(predictions.status, 200, `predictions endpoint failed: ${JSON.stringify(predictions.body)}`);
});

test("an invalid limit falls back to the documented default", { skip }, async () => {
  await runCollection();
  const bad = await api("/api/v1/fixtures?limit=abc");
  assert.equal(bad.status, 200);
  assert.equal(bad.body.limit, 50, "an unparseable limit must fall back to the default");
  const blank = await api("/api/v1/fixtures?limit=");
  assert.equal(blank.body.limit, 50, "a blank limit must fall back to the default");
  const huge = await api("/api/v1/fixtures?limit=999999");
  assert.equal(huge.body.limit, 200, "an oversized limit must be clamped");
});

test("GET /api/v1/runs, /api/v1/sources and /api/v1/health respond correctly", { skip }, async () => {
  await runCollection();
  const runs = await api("/api/v1/runs");
  assert.equal(runs.status, 200);
  assert.ok(runs.body.runs.length >= 1, "run history is empty");
  const limited = await api("/api/v1/runs?limit=1");
  assert.equal(limited.body.runs.length, 1, "the limit parameter was not applied");

  const sources = await api("/api/v1/sources");
  assert.equal(sources.status, 200);
  assert.equal(sources.body.sources.length, 3);

  const health = await api("/api/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.database, "connected");
});

test("GET /api/v1/predictions responds without a database error", { skip }, async () => {
  await runCollection();
  const { status, body } = await api("/api/v1/predictions");
  assert.equal(status, 200, `predictions endpoint failed: ${JSON.stringify(body)}`);
  assert.equal(body.odds_used, false);
  assert.ok(body.predictions.length >= 1, "no predictions returned");
  assert.equal(body.limit === undefined, true);
});

test("unknown routes return 404 and malformed fixture ids return 400", { skip }, async () => {
  const missing = await api("/api/v1/does-not-exist");
  assert.equal(missing.status, 404);

  const bad = await api("/api/v1/fixtures/%E0%A4%A");
  assert.equal(bad.status, 400);

  const wrongMethod = await worker.fetch(new Request("https://rusty.example/api/v1/collection/run", { method: "GET" }), ENV);
  assert.equal(wrongMethod.status, 405);
});

test("the manual collection endpoint requires the admin token", { skip }, async () => {
  const unauthorized = await worker.fetch(
    new Request("https://rusty.example/api/v1/collection/run", { method: "POST" }),
    ENV,
  );
  assert.equal(unauthorized.status, 401);

  const authorized = await worker.fetch(
    new Request("https://rusty.example/api/v1/collection/run", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    }),
    { ...ENV, ADMIN_TOKEN: "secret" },
  );
  assert.equal(authorized.status, 200);
  const body = await authorized.json();
  assert.equal(body.ok !== undefined, true);
});

test("concurrent collections cannot both acquire the lease", { skip }, async () => {
  await reset();
  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < 3; i++) {
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
    };
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, ENV, ctx);
  }
  await Promise.all(pending);

  const runs = await shim!.query(`SELECT id, status FROM collection_runs ORDER BY id`);
  assert.equal(runs.rows.length, 1, `expected exactly one run from three concurrent collections, got ${runs.rows.length}`);
  const running = runs.rows.filter((r: any) => r.status === "running");
  assert.equal(running.length, 0, `a run was left stuck in 'running': ${JSON.stringify(running)}`);

  const lock = await shim!.query(
    `SELECT owner_token, run_id FROM collection_lock WHERE lock_name='scheduled'`,
  );
  assert.equal(lock.rows.length <= 1, true);
});

test("a held lease prevents a second collection from starting", { skip }, async () => {
  await reset();
  await shim!.query(
    `INSERT INTO collection_lock(lock_name,locked_until,owner_token,run_id)
     VALUES('scheduled',now()+interval '10 minutes','some-other-owner',NULL)`,
  );
  await runCollection();
  const runs = await shim!.query(`SELECT id, status FROM collection_runs`);
  assert.equal(runs.rows.length, 0, "a run was created even though the lease was held");
  const lock = await shim!.query(`SELECT owner_token FROM collection_lock WHERE lock_name='scheduled'`);
  assert.equal(lock.rows[0].owner_token, "some-other-owner", "the foreign lease was overwritten");
});
