#!/usr/bin/env bash
#
# One-command local test run for the Rusty Cloudflare Worker.
#
#   scripts/test-local.sh [--live] [--db=postgres://user:pass@host:port/db]
#
# What it does:
#   1. creates the test database (if it does not exist) and applies migrations 0001-0007
#   2. runs the unit + integration test suite against it
#   3. boots the Worker locally on top of that database
#   4. runs the HTTP smoke test against the running Worker
#
# --live makes the local Worker call the real upstream provider APIs instead of the
# deterministic test fixtures.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DB_URL="${DATABASE_URL:-postgres://postgres@127.0.0.1:5432/rusty_test}"
PORT="${PORT:-8788}"
LIVE=0
for arg in "$@"; do
  case "$arg" in
    --live) LIVE=1 ;;
    --db=*) DB_URL="${arg#--db=}" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Swap the database name in the path for the maintenance database, e.g.
# postgres://u:p@h:5432/rusty_test -> postgres://u:p@h:5432/postgres
ADMIN_URL="$(echo "$DB_URL" | sed -E 's#/[^/?]*(\?.*)?$#/postgres\1#')"
DB_NAME="$(echo "$DB_URL" | sed -E 's#.*/([^/?]+).*#\1#')"
PSQL="${PSQL:-psql}"

echo "==> database: $DB_NAME"

# 1. database + migrations ----------------------------------------------------
if command -v "$PSQL" >/dev/null 2>&1; then
  if ! "$PSQL" "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
    "$PSQL" "$ADMIN_URL" -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null 2>&1 \
      || echo "==> could not create the database, continuing with the existing one"
  fi
  for migration in "$ROOT"/rust-engine/migrations/000*.sql; do
    "$PSQL" "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$migration" >/dev/null 2>&1 \
      || { echo "!! migration failed: $(basename "$migration")"; exit 1; }
  done
  echo "==> migrations 0001-0007 applied"
else
  echo "==> psql not found, skipping database provisioning"
fi

# 2. test suite ---------------------------------------------------------------
echo "==> installing dependencies if needed"
if [ ! -d "$ROOT/cloudflare/node_modules" ]; then
  (cd "$ROOT/cloudflare" && npm install --no-audit --no-fund) || {
    echo "!! npm install failed"; exit 1;
  }
fi

echo "==> running the test suite"
(
  cd "$ROOT/cloudflare"
  npm test
)
TEST_STATUS=$?

# 3. local server -------------------------------------------------------------
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

MOCK_FLAG="--mock"
[ "$LIVE" = "1" ] && MOCK_FLAG=""

echo "==> starting the local Worker on port $PORT (live providers: $([ "$LIVE" = "1" ] && echo yes || echo no))"
node --experimental-strip-types "$ROOT/scripts/local-server.ts" \
  --database-url="$DB_URL" --port="$PORT" --admin-token=local-admin $MOCK_FLAG \
  > /tmp/rusty-local-server.log 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 30); do
  sleep 1
  if curl -sf -m 3 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then break; fi
done

if ! curl -sf -m 5 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then
  echo "!! the local server did not come up; log:"
  cat /tmp/rusty-local-server.log
  exit 1
fi

# 4. smoke test ---------------------------------------------------------------
echo "==> running the smoke test"
(
  cd "$ROOT/cloudflare"
  node --experimental-strip-types test/smoke.ts "http://127.0.0.1:$PORT" \
    --admin-token=local-admin --trigger
)
SMOKE_STATUS=$?

echo
if [ "$TEST_STATUS" -eq 0 ] && [ "$SMOKE_STATUS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "FAILURES: test suite exit=$TEST_STATUS, smoke exit=$SMOKE_STATUS"
exit 1
