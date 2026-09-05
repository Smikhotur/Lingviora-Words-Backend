import { hashToken, randomToken } from "./crypto";

export type EmailTokenType = "verify_email" | "change_email" | "reset_password";

export async function createEmailToken(db: D1Database, userId: string, email: string, type: EmailTokenType, lifetimeMs: number) {
  const rawToken = randomToken(32);
  const now = new Date();
  await db.batch([
    db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND type = ? AND used_at IS NULL").bind(userId, type),
    db.prepare(`INSERT INTO email_tokens (id, user_id, type, email, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`).bind(crypto.randomUUID(), userId, type, email, await hashToken(rawToken), new Date(now.getTime() + lifetimeMs).toISOString(), now.toISOString())
  ]);
  return rawToken;
}
