import test from "node:test";
import assert from "node:assert/strict";
import { classifyResultState, validScore, safeInt, parseJsonBody, isRetryableStatus, parseTimestamp } from "../src/guards.ts";

test("eAdriatic Normal / Scheduled and approval are never treated as completed", () => {
  assert.equal(classifyResultState("eadriatic", "Normal approved=true", {fixtureDateStatusDesc:"Normal / Scheduled"}), "scheduled");
  assert.equal(classifyResultState("eadriatic", "Normal approved=true"), "unknown");
});
test("only explicit terminal states are completed", () => {
  for (const s of ["Finished", "Completed", "Full Time", "FT", "Played", "Settled"]) assert.equal(classifyResultState("gt", s), "completed");
  assert.equal(classifyResultState("gt", "not finished"), "unknown");
  assert.equal(classifyResultState("gt", "upcoming"), "scheduled");
  assert.equal(classifyResultState("gt", "unknown code"), "unknown");
});
test("scores and query parameters are bounded", () => {
  assert.equal(validScore("0"), true); assert.equal(validScore("2"), true); assert.equal(validScore("1.5"), false); assert.equal(validScore("-1"), false);
  assert.equal(safeInt("abc", 25, 1, 100), 25); assert.equal(safeInt("999", 25, 1, 100), 100);
});
test("a missing query parameter falls back to the default instead of the minimum", () => {
  // Number(null) is 0, which silently collapsed every default limit to 1.
  assert.equal(safeInt(null, 25, 1, 100), 25);
  assert.equal(safeInt(undefined, 30, 1, 100), 30);
  assert.equal(safeInt("", 50, 1, 200), 50);
  assert.equal(safeInt("   ", 50, 1, 200), 50);
  assert.equal(safeInt(null, 0, 0, 1000000), 0);
  assert.equal(safeInt("0", 25, 1, 100), 1);
});
test("GT numeric fixture status codes are mapped to explicit result states", () => {
  assert.equal(classifyResultState("gt", 3), "completed"); // ended
  assert.equal(classifyResultState("gt", 0), "scheduled"); // not_started
  assert.equal(classifyResultState("gt", 1), "live"); // live
  assert.equal(classifyResultState("gt", 2), "postponed"); // suspended
  assert.equal(classifyResultState("gt", 4), "cancelled"); // cancelled
  assert.equal(classifyResultState("gt", 5), "postponed"); // postponed
  assert.equal(classifyResultState("gt", 6), "cancelled"); // forfeit
  assert.equal(classifyResultState("gt", 10), "unknown"); // unknown
  assert.equal(classifyResultState("gt", 77), "unknown"); // unmapped code stays unknown
  assert.equal(classifyResultState("gt", "3"), "completed");
});
test("a numeric status never leaks into label matching for other sources", () => {
  assert.equal(classifyResultState("eadriatic", 0), "unknown");
  assert.equal(classifyResultState("eadriatic", 1), "unknown");
});
test("upstream JSON failures have stable actionable errors", () => {
  assert.throws(() => parseJsonBody("", "BETIKA"), /BETIKA_EMPTY_RESPONSE_BODY/);
  assert.throws(() => parseJsonBody("{", "BETIKA"), /BETIKA_INVALID_JSON_RESPONSE/);
  assert.deepEqual(parseJsonBody('{"data":[]}', "BETIKA"), {data:[]});
});
test("only transient HTTP statuses are retried", () => {
  assert.equal(isRetryableStatus(500), true); assert.equal(isRetryableStatus(408), true); assert.equal(isRetryableStatus(429), false); assert.equal(isRetryableStatus(451), false); assert.equal(isRetryableStatus(404), false);
});
test("ambiguous local timestamps are rejected rather than guessed", () => {
  assert.equal(parseTimestamp("2026-11-03T19:00:00Z"), Date.parse("2026-11-03T19:00:00Z"));
  assert.equal(parseTimestamp("1762196400"), 1762196400000);
  assert.equal(parseTimestamp("20261103 19:00"), null);
  assert.equal(parseTimestamp("2026-11-03T19:00:00"), null);
});

test("canonical timestamps accept Date objects and numeric epoch milliseconds", () => {
  const expected = Date.parse("2026-11-20T20:00:00.000Z");
  assert.equal(parseTimestamp(new Date(expected)), expected);
  assert.equal(parseTimestamp(expected), expected);
  assert.equal(parseTimestamp("1795204800000"), 1795204800000);
});
