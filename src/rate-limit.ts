import { HttpError } from "./http";

export async function enforceRateLimit(db: D1Database, key: string, limit: number, windowMs: number) {
  const now = new Date();
  const resetBefore = new Date(now.getTime() - windowMs).toISOString();
  const row = await db.prepare(`INSERT INTO rate_limits (key, count, window_started_at, expires_at) VALUES (?, 1, ?, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate_limits.window_started_at < ? THEN 1 ELSE rate_limits.count + 1 END, window_started_at = CASE WHEN rate_limits.window_started_at < ? THEN excluded.window_started_at ELSE rate_limits.window_started_at END, expires_at = excluded.expires_at RETURNING count`).bind(key, now.toISOString(), new Date(now.getTime() + windowMs).toISOString(), resetBefore, resetBefore).first<{ count: number }>();
  if (!row || Number(row.count) > limit) throw new HttpError(429, "Забагато спроб. Спробуйте трохи пізніше.");
}
