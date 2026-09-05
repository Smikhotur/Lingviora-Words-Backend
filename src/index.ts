import { errorResponse, preflight, withResponseHeaders } from "./http";
import { routeApi } from "./router";
import type { Env } from "./types";

async function handle(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    if (request.method === "OPTIONS") return preflight(request, env);
    try {
      return await routeApi(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (!env.ASSETS) return new Response("Not found", { status: 404 });
  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 404 || request.method !== "GET" || /\.[a-z0-9]+$/i.test(url.pathname)) return asset;
  return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), { method: "GET", headers: request.headers }));
}

export default {
  async fetch(request: Request, env: Env) {
    return withResponseHeaders(await handle(request, env), request, env);
  }
};
