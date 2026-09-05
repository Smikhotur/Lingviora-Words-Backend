import type { Env } from "./types";

export function appBaseUrl(env: Env, request: Request) {
  const configured = env.APP_BASE_URL?.trim();
  if (env.APP_ENV === "production" && !configured) {
    throw new Error("APP_BASE_URL is required in production");
  }

  let url: URL;
  try {
    url = new URL(configured || new URL(request.url).origin);
  } catch {
    throw new Error("APP_BASE_URL must be a valid absolute URL");
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("APP_BASE_URL must be a clean HTTP(S) URL");
  }
  if (env.APP_ENV === "production" && url.protocol !== "https:") {
    throw new Error("APP_BASE_URL must use HTTPS in production");
  }

  return url.href.replace(/\/$/, "");
}
