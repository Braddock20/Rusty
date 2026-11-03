
import { neon } from "@neondatabase/serverless";

interface Env {
  DATABASE_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "esports-edge-api",
        database: "not_checked"
      });
    }

    if (url.pathname === "/health/db") {
      if (!env.DATABASE_URL) {
        return Response.json({
          ok: false,
          error: "DATABASE_URL secret is missing"
        }, { status: 500 });
      }

      try {
        const sql = neon(env.DATABASE_URL);

        const result = await sql`
          SELECT
            NOW() AS database_time,
            current_database() AS database_name
        `;

        return Response.json({
          ok: true,
          service: "esports-edge-api",
          database: "connected",
          details: result[0]
        });
      } catch (error) {
        return Response.json({
          ok: false,
          database: "connection_failed",
          error: error instanceof Error
            ? error.message
            : "Unknown database error"
        }, { status: 500 });
      }
    }

    return Response.json({
      service: "Esports Data Engine",
      status: "online",
      endpoints: ["/health", "/health/db"]
    });
  }
};
