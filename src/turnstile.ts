import { HttpError } from "./http";
import type { Env } from "./types";

export type TurnstileAction = "register" | "forgot_password";

export type TurnstileResult = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

function configuredHostnames(env: Env) {
  return (env.TURNSTILE_EXPECTED_HOSTNAMES ?? "")
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

export function turnstileResultIsValid(result: TurnstileResult, action: TurnstileAction, hostnames: string[]) {
  if (!result.success || result.action !== action) return false;
  if (!hostnames.length) return true;
  const hostname = result.hostname?.toLowerCase().replace(/\.$/, "");
  return Boolean(hostname && hostnames.includes(hostname));
}

export async function verifyCaptcha(env: Env, token: string, request: Request, action: TurnstileAction) {
  if (!env.TURNSTILE_SECRET_KEY) throw new HttpError(503, "Капча ще не налаштована");
  if (!token || token.length > 2048) throw new HttpError(400, "Некоректна відповідь капчі");

  const hostnames = configuredHostnames(env);
  if (env.APP_ENV === "production" && !hostnames.length) {
    throw new HttpError(503, "Капча ще не налаштована для production-домену");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try {
    const body: Record<string, string> = {
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      idempotency_key: crypto.randomUUID()
    };
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) body.remoteip = ip;
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch {
    throw new HttpError(503, "Сервіс капчі тимчасово недоступний");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw new HttpError(503, "Сервіс капчі тимчасово недоступний");
  let result: TurnstileResult;
  try {
    result = await response.json<TurnstileResult>();
  } catch {
    throw new HttpError(503, "Сервіс капчі повернув некоректну відповідь");
  }

  if (!turnstileResultIsValid(result, action, hostnames)) {
    console.warn("Turnstile validation rejected", { action, hostname: result.hostname, errors: result["error-codes"] });
    throw new HttpError(400, "Не вдалося підтвердити капчу. Спробуйте ще раз.");
  }
}
