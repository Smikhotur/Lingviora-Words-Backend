import { changeEmail, changePassword, testMailbox } from "./routes/account";
import { forgotPassword, login, logout, me, register, resendVerification, resetPassword, verifyEmail } from "./routes/auth";
import { answer, known, session } from "./routes/learning";
import { createWord, listIndex, listItem, wordItem } from "./routes/lists";
import { HttpError, json } from "./http";
import type { Env } from "./types";

function allow(request: Request, methods: string[]) {
  if (!methods.includes(request.method)) throw new HttpError(405, "Метод не підтримується");
}

export async function routeApi(request: Request, env: Env) {
  const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";

  if (path === "/api/health") {
    allow(request, ["GET"]);
    return json({ status: "ok" });
  }
  if (path === "/api/public-config") {
    allow(request, ["GET"]);
    return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null, testMailbox: env.APP_ENV !== "production" && env.ALLOW_TEST_MAILBOX === "true" });
  }
  if (path === "/api/auth/me") { allow(request, ["GET"]); return me(request, env); }
  if (path === "/api/auth/register") { allow(request, ["POST"]); return register(request, env); }
  if (path === "/api/auth/login") { allow(request, ["POST"]); return login(request, env); }
  if (path === "/api/auth/logout") { allow(request, ["POST"]); return logout(request, env); }
  if (path === "/api/auth/forgot-password") { allow(request, ["POST"]); return forgotPassword(request, env); }
  if (path === "/api/auth/reset-password") { allow(request, ["POST"]); return resetPassword(request, env); }
  if (path === "/api/auth/verify-email") { allow(request, ["POST"]); return verifyEmail(request, env); }
  if (path === "/api/auth/resend-verification") { allow(request, ["POST"]); return resendVerification(request, env); }
  if (path === "/api/account/email") { allow(request, ["POST"]); return changeEmail(request, env); }
  if (path === "/api/account/password") { allow(request, ["POST"]); return changePassword(request, env); }
  if (path === "/api/test-mailbox") { allow(request, ["GET"]); return testMailbox(request, env); }
  if (path === "/api/lists") { allow(request, ["GET", "POST"]); return listIndex(request, env); }
  if (path === "/api/learn/session") { allow(request, ["GET"]); return session(request, env); }
  if (path === "/api/learn/answer") { allow(request, ["POST"]); return answer(request, env); }
  if (path === "/api/learn/known") { allow(request, ["POST"]); return known(request, env); }

  const listWordsMatch = path.match(/^\/api\/lists\/([^/]+)\/words$/);
  if (listWordsMatch) { allow(request, ["POST"]); return createWord(request, env, decodeURIComponent(listWordsMatch[1])); }
  const listMatch = path.match(/^\/api\/lists\/([^/]+)$/);
  if (listMatch) { allow(request, ["GET", "PATCH", "DELETE"]); return listItem(request, env, decodeURIComponent(listMatch[1])); }
  const wordMatch = path.match(/^\/api\/words\/([^/]+)$/);
  if (wordMatch) { allow(request, ["PATCH", "DELETE"]); return wordItem(request, env, decodeURIComponent(wordMatch[1])); }
  throw new HttpError(404, "Маршрут не знайдено");
}
