import { clearSession, createSession, getCurrentSession, requireUser } from "../auth";
import { appBaseUrl } from "../config";
import { anonymousFingerprint, createPasswordHash, hashToken, verifyPassword } from "../crypto";
import { createEmailToken } from "../email-tokens";
import { assertEmailDeliveryConfigured, resetEmail, sendEmail, verificationEmail } from "../email";
import { assertTrustedOrigin, firstValidationError, HttpError, json, parseJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import { verifyCaptcha } from "../turnstile";
import type { Env } from "../types";
import { forgotPasswordSchema, loginSchema, registrationSchema, resetPasswordSchema, tokenSchema } from "../validation";

export async function me(request: Request, env: Env) {
  const session = await getCurrentSession(env.DB, request);
  if (!session) return json({ user: null });
  const { sessionId: _sessionId, sessionExpiresAt: _expiresAt, ...user } = session;
  return json({ user });
}

export async function register(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  const parsed = registrationSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  const applicationUrl = appBaseUrl(env, request);
  assertEmailDeliveryConfigured(env);
  await enforceRateLimit(env.DB, await anonymousFingerprint(request, "register"), 5, 3_600_000);
  await verifyCaptcha(env, parsed.data.captchaToken, request, "register");
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? OR pending_email = ? LIMIT 1").bind(parsed.data.email, parsed.data.email).first();
  if (existing) throw new HttpError(409, "Обліковий запис із цією адресою вже існує");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const password = await createPasswordHash(parsed.data.password);
  await env.DB.prepare(`INSERT INTO users (id, email, pending_email, password_hash, password_salt, email_verified_at, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)`).bind(id, parsed.data.email, password.hash, password.salt, now, now).run();
  const token = await createEmailToken(env.DB, id, parsed.data.email, "verify_email", 86_400_000);
  let emailSent = true;
  try {
    await sendEmail(env.DB, env, { to: parsed.data.email, ...verificationEmail(`${applicationUrl}/verify-email?token=${encodeURIComponent(token)}`) });
  } catch (error) {
    console.error(error);
    emailSent = false;
  }
  return json({ ok: true, emailSent }, 201, { "set-cookie": await createSession(env.DB, id, request, env) });
}

export async function login(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  const parsed = loginSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  const fingerprint = await anonymousFingerprint(request, "login");
  await enforceRateLimit(env.DB, `${fingerprint}:${await hashToken(parsed.data.email)}`, 10, 900_000);
  const user = await env.DB.prepare(`SELECT id, password_hash AS passwordHash, password_salt AS passwordSalt, email_verified_at AS emailVerifiedAt FROM users WHERE email = ? LIMIT 1`).bind(parsed.data.email).first<{ id: string; passwordHash: string; passwordSalt: string; emailVerifiedAt: string | null }>();
  const valid = user ? await verifyPassword(parsed.data.password, user.passwordHash, user.passwordSalt) : Boolean(await createPasswordHash(parsed.data.password)) && false;
  if (!user || !valid) throw new HttpError(401, "Неправильна пошта або пароль");
  return json({ ok: true, verified: Boolean(user.emailVerifiedAt) }, 200, { "set-cookie": await createSession(env.DB, user.id, request, env) });
}

export async function logout(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  return json({ ok: true }, 200, { "set-cookie": await clearSession(env.DB, request, env) });
}

export async function forgotPassword(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  const parsed = forgotPasswordSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  const applicationUrl = appBaseUrl(env, request);
  assertEmailDeliveryConfigured(env);
  await enforceRateLimit(env.DB, await anonymousFingerprint(request, "forgot-password"), 5, 3_600_000);
  await verifyCaptcha(env, parsed.data.captchaToken, request, "forgot_password");
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ? LIMIT 1").bind(parsed.data.email).first<{ id: string; email: string }>();
  if (user) {
    const token = await createEmailToken(env.DB, user.id, user.email, "reset_password", 1_800_000);
    try {
      await sendEmail(env.DB, env, { to: user.email, ...resetEmail(`${applicationUrl}/reset-password?token=${encodeURIComponent(token)}`) });
    } catch (error) {
      console.error(error);
    }
  }
  return json({ ok: true });
}

export async function resetPassword(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  const parsed = resetPasswordSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  const token = await env.DB.prepare(`SELECT id, user_id AS userId FROM email_tokens WHERE token_hash = ? AND type = 'reset_password' AND used_at IS NULL AND expires_at > ? LIMIT 1`).bind(await hashToken(parsed.data.token), new Date().toISOString()).first<{ id: string; userId: string }>();
  if (!token) throw new HttpError(400, "Посилання недійсне або вже неактивне");
  const password = await createPasswordHash(parsed.data.password);
  const now = new Date().toISOString();
  const consumed = await env.DB.prepare("UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, token.id).run();
  if (!consumed.meta.changes) throw new HttpError(400, "Посилання вже використано");
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?").bind(password.hash, password.salt, now, token.userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(token.userId)
  ]);
  return json({ ok: true }, 200, { "set-cookie": await createSession(env.DB, token.userId, request, env) });
}

export async function verifyEmail(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  const parsed = tokenSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  const token = await env.DB.prepare(`SELECT id, user_id AS userId, type, email FROM email_tokens WHERE token_hash = ? AND type IN ('verify_email', 'change_email') AND used_at IS NULL AND expires_at > ? LIMIT 1`).bind(await hashToken(parsed.data.token), new Date().toISOString()).first<{ id: string; userId: string; type: "verify_email" | "change_email"; email: string }>();
  if (!token) throw new HttpError(400, "Посилання недійсне або вже неактивне");
  const now = new Date().toISOString();
  const consumed = await env.DB.prepare("UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, token.id).run();
  if (!consumed.meta.changes) throw new HttpError(400, "Посилання вже використано");
  const update = token.type === "change_email"
    ? env.DB.prepare(`UPDATE users SET email = ?, pending_email = NULL, email_verified_at = ?, updated_at = ? WHERE id = ? AND pending_email = ?`).bind(token.email, now, now, token.userId, token.email)
    : env.DB.prepare(`UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ? AND email = ?`).bind(now, now, token.userId, token.email);
  if (!(await update.run()).meta.changes) throw new HttpError(409, "Адресу було змінено іншим запитом. Запросіть новий лист.");
  return json({ ok: true, type: token.type });
}

export async function resendVerification(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  const user = await requireUser(env.DB, request, false);
  if (user.emailVerifiedAt && !user.pendingEmail) throw new HttpError(400, "Адресу вже підтверджено");
  const applicationUrl = appBaseUrl(env, request);
  assertEmailDeliveryConfigured(env);
  await enforceRateLimit(env.DB, `resend:${user.id}`, 3, 3_600_000);
  const change = Boolean(user.pendingEmail);
  const email = user.pendingEmail ?? user.email;
  const token = await createEmailToken(env.DB, user.id, email, change ? "change_email" : "verify_email", 86_400_000);
  await sendEmail(env.DB, env, { to: email, ...verificationEmail(`${applicationUrl}/verify-email?token=${encodeURIComponent(token)}`, change) });
  return json({ ok: true });
}
