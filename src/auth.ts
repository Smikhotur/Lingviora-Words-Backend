import { hashToken, randomToken } from "./crypto";
import { HttpError } from "./http";
import type { Env, UserSummary } from "./types";

const SESSION_COOKIE = "lingviora_session";
const SESSION_DAYS = 30;

type SessionRow = UserSummary & { sessionId: string; sessionExpiresAt: string };

function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const item of cookies.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookie(value: string, request: Request, env: Env, expires?: Date) {
  const sameSite = env.COOKIE_SAME_SITE === "none" ? "None" : "Lax";
  const secure = new URL(request.url).protocol === "https:" || sameSite === "None";
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    secure ? "Secure" : "",
    expires ? `Expires=${expires.toUTCString()}` : "Max-Age=0"
  ].filter(Boolean).join("; ");
}

export async function createSession(db: D1Database, userId: string, request: Request, env: Env) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await db.prepare(`INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), await hashToken(token), userId, expires.toISOString(), now.toISOString()).run();
  return sessionCookie(token, request, env, expires);
}

export async function clearSession(db: D1Database, request: Request, env: Env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
  return sessionCookie("", request, env);
}

export async function getCurrentSession(db: D1Database, request: Request): Promise<SessionRow | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return await db.prepare(`SELECT u.id, u.email, u.pending_email AS pendingEmail, u.email_verified_at AS emailVerifiedAt, s.id AS sessionId, s.expires_at AS sessionExpiresAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1`).bind(await hashToken(token), new Date().toISOString()).first<SessionRow>() ?? null;
}

export async function requireUser(db: D1Database, request: Request, verified = true) {
  const session = await getCurrentSession(db, request);
  if (!session) throw new HttpError(401, "Увійдіть до облікового запису");
  if (verified && !session.emailVerifiedAt) throw new HttpError(403, "Спочатку підтвердьте електронну адресу");
  return session;
}
