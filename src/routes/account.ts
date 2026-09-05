import { createSession, requireUser } from "../auth";
import { appBaseUrl } from "../config";
import { createPasswordHash, verifyPassword } from "../crypto";
import { createEmailToken } from "../email-tokens";
import { assertEmailDeliveryConfigured, sendEmail, verificationEmail } from "../email";
import { assertTrustedOrigin, firstValidationError, HttpError, json, parseJson } from "../http";
import type { Env } from "../types";
import { changeEmailSchema, changePasswordSchema } from "../validation";

async function credentials(env: Env, userId: string) {
  return env.DB.prepare("SELECT password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE id = ?").bind(userId).first<{ passwordHash: string; passwordSalt: string }>();
}

export async function changeEmail(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  const user = await requireUser(env.DB, request);
  const parsed = changeEmailSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  if (parsed.data.newEmail === user.email) throw new HttpError(400, "Це Ваша поточна електронна адреса");
  const applicationUrl = appBaseUrl(env, request);
  assertEmailDeliveryConfigured(env);
  const current = await credentials(env, user.id);
  if (!current || !(await verifyPassword(parsed.data.currentPassword, current.passwordHash, current.passwordSalt))) throw new HttpError(400, "Поточний пароль введено неправильно");
  const existing = await env.DB.prepare("SELECT id FROM users WHERE (email = ? OR pending_email = ?) AND id != ? LIMIT 1").bind(parsed.data.newEmail, parsed.data.newEmail, user.id).first();
  if (existing) throw new HttpError(409, "Ця електронна адреса вже використовується");
  await env.DB.prepare("UPDATE users SET pending_email = ?, updated_at = ? WHERE id = ?").bind(parsed.data.newEmail, new Date().toISOString(), user.id).run();
  const token = await createEmailToken(env.DB, user.id, parsed.data.newEmail, "change_email", 86_400_000);
  await sendEmail(env.DB, env, { to: parsed.data.newEmail, ...verificationEmail(`${applicationUrl}/verify-email?token=${encodeURIComponent(token)}`, true) });
  return json({ ok: true, pendingEmail: parsed.data.newEmail });
}

export async function changePassword(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  const user = await requireUser(env.DB, request);
  const parsed = changePasswordSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  const current = await credentials(env, user.id);
  if (!current || !(await verifyPassword(parsed.data.currentPassword, current.passwordHash, current.passwordSalt))) throw new HttpError(400, "Поточний пароль введено неправильно");
  const password = await createPasswordHash(parsed.data.newPassword);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?").bind(password.hash, password.salt, now, user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id)
  ]);
  return json({ ok: true }, 200, { "set-cookie": await createSession(env.DB, user.id, request, env) });
}

export async function testMailbox(request: Request, env: Env) {
  if (env.APP_ENV === "production" || env.ALLOW_TEST_MAILBOX !== "true") throw new HttpError(404, "Сторінку не знайдено");
  const user = await requireUser(env.DB, request, false);
  const recipients = [user.email, user.pendingEmail].filter(Boolean) as string[];
  const placeholders = recipients.map(() => "?").join(", ");
  const result = await env.DB.prepare(`SELECT id, subject, text_body AS textBody, created_at AS createdAt FROM email_outbox WHERE recipient IN (${placeholders}) ORDER BY created_at DESC LIMIT 20`).bind(...recipients).all<{ id: string; subject: string; textBody: string; createdAt: string }>();
  return json({ messages: result.results.map((message) => ({ id: message.id, subject: message.subject, createdAt: message.createdAt, link: message.textBody.match(/https?:\/\/\S+/)?.[0] ?? null })) });
}
