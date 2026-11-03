/**
 * Runs the Cloudflare Worker locally against a plain PostgreSQL database.
 *
 * The Worker talks to `@neondatabase/serverless`, which speaks the Neon HTTP `/sql`
 * protocol. The shim implements that protocol on top of PostgreSQL, so the unmodified
 * Worker runs here without a Neon account.
 *
 *   node --experimental-strip-types scripts/local-server.ts \
 *     --database-url=postgres://postgres@127.0.0.1:5432/rusty [--port=8787] [--admin-token=...]
 *
 * By default upstream provider calls go to the real APIs. Use --mock to serve the
 * deterministic fixtures from cloudflare/test/helpers/provider-fixtures.ts instead.
 */
import http from "node:http";
import { startNeonShim, installFetchStub } from "../cloudflare/test/helpers/neon-shim.ts";
import { providerResponse } from "../cloudflare/test/helpers/provider-fixtures.ts";

const args = new Map<string, string>();
for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (match) args.set(match[1]!, match[2] ?? "true");
}

const databaseUrl = args.get("database-url");
if (!databaseUrl) {
  console.error(
    "usage: --database-url=postgres://user:pass@host:port/db [--port=8787] [--admin-token=X] [--mock]",
  );
  process.exit(2);
}
const port = Number(args.get("port") ?? 8787);
const adminToken = args.get("admin-token");
const useMock = args.get("mock") === "true";

const shim = await startNeonShim(databaseUrl);
// No provider handler means upstream traffic is passed through to the real network.
installFetchStub(shim.url, useMock ? (url: string) => providerResponse(url) : undefined);

const worker = (await import("../cloudflare/src/index.ts")).default;
const env = {
  // The Neon driver parses this URL even though the shim routes the traffic to the
  // local PostgreSQL instance, so it must be a complete, well-formed connection string.
  DATABASE_URL: "postgresql://local:local@127.0.0.1:5432/rusty?sslmode=disable",
  ...(adminToken ? { ADMIN_TOKEN: adminToken } : {}),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.from(c)));
  req.on("end", () => {
    void (async () => {
      const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(body ? { body } : {}),
      });
      try {
        const response = await worker.fetch(request, env);
        const text = await response.text();
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(text);
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "local server failure", detail: String(error) }));
      }
    })();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Rusty local server on http://127.0.0.1:${port}`);
  console.log(`  database : ${databaseUrl}`);
  console.log(`  providers: ${useMock ? "mock fixtures" : "live upstream APIs"}`);
  console.log(`  admin    : ${adminToken ? "enabled" : "disabled"}`);
});
