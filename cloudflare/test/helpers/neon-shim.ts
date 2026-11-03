/**
 * Local Neon-SQL-compatible HTTP shim backed by PostgreSQL.
 *
 * The Worker is written against `@neondatabase/serverless`, which talks to Neon over
 * an HTTP `/sql` endpoint using `Neon-Raw-Text-Output` + `Neon-Array-Mode`.
 * This shim reproduces that protocol in front of a real PostgreSQL database so the
 * production Worker code can be executed unmodified in tests.
 */
import http from "node:http";
import pg from "pg";

const { Pool } = pg;

/** Neon raw-text output returns every value as its PostgreSQL text representation. */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : String(value);
  if (Buffer.isBuffer(value)) return "\\x" + value.toString("hex");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface NeonShim {
  url: string;
  query: (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
  close: () => Promise<void>;
}

export async function startNeonShim(connectionString: string): Promise<NeonShim> {
  const pool = new Pool({ connectionString, max: 8 });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      void (async () => {
        let payload: any = {};
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          payload = {};
        }
        const text: string = payload.query ?? "";
        const values: unknown[] = payload.params ?? [];
        try {
          // Neon batch protocol (`sql.transaction([...])`): an array of queries
          // executed as one non-interactive transaction.
          if (Array.isArray(payload.queries)) {
            const client = await pool.connect();
            const batchResults: unknown[] = [];
            try {
              await client.query("BEGIN");
              for (const q of payload.queries) {
                const r = await client.query({ text: q.query, values: q.params ?? [] });
                batchResults.push({
                  command: r.command ?? "SELECT",
                  fields: r.fields.map((f) => ({
                    name: f.name,
                    tableId: 0,
                    columnId: 0,
                    dataTypeID: f.dataTypeID,
                    format: "text",
                  })),
                  rowCount: r.rowCount ?? 0,
                  rows: r.rows.map((row) => r.fields.map((f) => toText(row[f.name]))),
                  rowAsArray: true,
                });
              }
              await client.query("COMMIT");
            } catch (batchError) {
              await client.query("ROLLBACK");
              throw batchError;
            } finally {
              client.release();
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ results: batchResults }));
            return;
          }

          const result = await pool.query({ text, values });
          const fields = result.fields.map((f) => ({
            name: f.name,
            tableId: 0,
            columnId: 0,
            dataTypeID: f.dataTypeID,
            format: "text",
          }));
          const rows = result.rows.map((row) => result.fields.map((f) => toText(row[f.name])));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              command: result.command ?? "SELECT",
              fields,
              rowCount: result.rowCount ?? rows.length,
              rows,
              rowAsArray: true,
            }),
          );
        } catch (error: any) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              message: error?.message ?? "query failed",
              severity: "ERROR",
              code: String(error?.code ?? "42601"),
              position: "1",
            }),
          );
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/sql`;

  return {
    url,
    query: (text: string, values: unknown[] = []) => pool.query({ text, values }),
    close: async () => {
      await pool.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Fetch = typeof globalThis.fetch;

/**
 * Routes the Neon driver's SQL traffic to the local shim and everything else to the
 * supplied provider handler. The Neon driver is identified by its own connection-string
 * header, so provider traffic is never mistaken for database traffic.
 */
export function installFetchStub(
  shimUrl: string,
  providerHandler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const realFetch: Fetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url: string = typeof input === "string" ? input : (input?.url ?? String(input));
    const headers: any = init?.headers;
    const isNeon =
      headers && typeof headers === "object" && !Array.isArray(headers)
        ? Boolean(headers["Neon-Connection-String"] || headers["neon-connection-string"])
        : false;
    if (isNeon) {
      return realFetch(shimUrl, { method: "POST", headers: { "content-type": "application/json" }, body: init?.body });
    }
    return providerHandler(url, init);
  }) as Fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}
