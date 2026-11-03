/** Defensive parsing and source-status classification shared by collectors and tests. */
export type ResultState = "unknown" | "scheduled" | "live" | "completed" | "cancelled" | "postponed";

/**
 * GT Sports Leagues exposes fixture status as a numeric enum rather than a label
 * (verified against https://api.gtleagues.com/api/fixtures). Without this mapping
 * every GT fixture stayed `unknown` and no GT match could ever be a result.
 */
const GT_STATUS_BY_CODE: Record<string, ResultState> = {
  "0": "scheduled", // not_started
  "1": "live", // live
  "2": "postponed", // suspended
  "3": "completed", // ended
  "4": "cancelled", // cancelled
  "5": "postponed", // postponed
  "6": "cancelled", // forfeit
  "10": "unknown", // unknown
};

const numericCode = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^\d{1,3}$/.test(value.trim())) return value.trim();
  return null;
};

export function classifyResultState(source: string, status: unknown, payload: any = null): ResultState {
  const candidates = [status, payload?.fixtureStatusDesc, payload?.fixtureDateStatusDesc,
    payload?.status, payload?.status_name, payload?.match_status];
  // A numeric provider status is an explicit machine-readable signal. Map it before
  // falling back to label matching, so "3" is never compared against a keyword.
  if (source === "gt") {
    for (const candidate of candidates) {
      const code = numericCode(candidate);
      if (code !== null) return GT_STATUS_BY_CODE[code] ?? "unknown";
    }
  }
  const parts = candidates
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
  // A missing or blank parameter must fall back to the documented default.
  // Number(null) is 0, which silently collapsed every default limit to the minimum.
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (text === "") return fallback;
  const n = Number(text);
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
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && value >= 1_000_000_000 && value < 100_000_000_000) return value * 1000;
    if (Number.isInteger(value) && value >= 100_000_000_000 && value <= 9_999_999_999_999) return value;
    return null;
  }
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
