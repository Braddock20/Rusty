/** Defensive parsing and source-status classification shared by collectors and tests. */
export type ResultState = "unknown" | "scheduled" | "live" | "completed" | "cancelled" | "postponed";

export function classifyResultState(_source: string, status: unknown, payload: any = null): ResultState {
  const parts = [status, payload?.fixtureStatusDesc, payload?.fixtureDateStatusDesc,
    payload?.status, payload?.status_name, payload?.match_status]
    .filter((x) => x !== null && x !== undefined)
    .map((x) => String(x).trim().toLowerCase());
  const text = parts.join(" | ");
  if (!text) return "unknown";
  if (/\b(cancelled|canceled|abandoned|void)\b/.test(text)) return "cancelled";
  if (/\b(postponed|suspended|delayed)\b/.test(text)) return "postponed";
  if (/\b(live|in[ -]?play|half[ -]?time)\b/.test(text)) return "live";
  // Negated terminal labels are not terminal states.
  if (/\b(not|never|no)\s+(finished|completed|complete|final|played|ended|ft)\b/.test(text)) return "unknown";
  // Do not treat approval, a score, "normal", or the generic word "result" as final.
  if (/\b(finished|completed|complete|final|full[ -]?time|ft|played|ended|settled)\b/.test(text)) return "completed";
  if (/\b(scheduled|upcoming|not[ -]?started|fixture)\b/.test(text)) return "scheduled";
  return "unknown";
}

export function validScore(value: unknown): boolean {
  if (value === null || value === undefined || String(value).trim() === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 99;
}

export function safeInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

export function parseJsonBody(body: string, source: string): any {
  if (!body || !body.trim()) throw new Error(`${source}_EMPTY_RESPONSE_BODY`);
  try { return JSON.parse(body); }
  catch { throw new Error(`${source}_INVALID_JSON_RESPONSE`); }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status >= 500;
}

/** ISO timestamps and epoch seconds/milliseconds only; ambiguous local clock strings are rejected. */
export function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (/^\d{10,13}$/.test(s)) {
    const raw = Number(s);
    const ms = s.length === 10 ? raw * 1000 : raw;
    return Number.isFinite(ms) ? ms : null;
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}
