import type { ZodError } from "zod";
import type { Env } from "./types";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function firstValidationError(error: ZodError) {
  return error.issues[0]?.message ?? "Перевірте введені дані";
}

export async function parseJson(request: Request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 32_768) throw new HttpError(413, "Запит надто великий");
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Некоректний формат запиту");
  }
}

function configuredOrigins(env: Env) {
  return new Set((env.ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

export function originIsAllowed(request: Request, env: Env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin || configuredOrigins(env).has(origin);
}

export function assertTrustedOrigin(request: Request, env: Env) {
  if (!originIsAllowed(request, env)) throw new HttpError(403, "Запит відхилено");
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  console.error(error);
  return json({ error: "Не вдалося виконати дію. Спробуйте ще раз." }, 500);
}

export function withResponseHeaders(response: Response, request: Request, env: Env) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin");
  if (origin && originIsAllowed(request, env)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.append("vary", "Origin");
  }
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("x-frame-options", "DENY");
  if (new URL(request.url).protocol === "https:") headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function preflight(request: Request, env: Env) {
  if (!originIsAllowed(request, env)) return json({ error: "Запит відхилено" }, 403);
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400"
    }
  });
}
