interface Env {
  ENGINE_URL: string;
  ENGINE_TOKEN: string;
  PUBLIC_API_ENABLED: string;
}
async function engine(env: Env, path: string, init: RequestInit = {}) {
  return fetch(new URL(path, env.ENGINE_URL), {
    ...init,
    headers: { ...(init.headers || {}), "Authorization": `Bearer ${env.ENGINE_TOKEN}`, "Content-Type": "application/json" }
  });
}
export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(engine(env, "/internal/collect", { method: "POST" }));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ok:true,service:"esports-edge-api"});
    if (env.PUBLIC_API_ENABLED !== "true") return new Response("API disabled", {status:503});
    const allowed = ["/api/v1/health", "/api/v1/fixtures", "/api/v1/runs"];
    if (!allowed.includes(url.pathname)) return new Response("Not found", {status:404});
    const target = new URL(url.pathname + url.search, env.ENGINE_URL);
    const upstream = await fetch(target, { headers: { "Accept":"application/json" } });
    return new Response(upstream.body, { status:upstream.status, headers: {
      "Content-Type":upstream.headers.get("Content-Type") || "application/json",
      "Cache-Control":"public, max-age=15"
    }});
  }
};
