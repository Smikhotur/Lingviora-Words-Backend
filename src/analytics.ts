import { HttpError } from "./http";
import type { UserSummary } from "./types";

const ANALYTICS_EMAIL = "smikhotur@gmail.com";
const PAGE_SIZES = new Set([10, 20, 50, 100]);

export function canViewAnalytics(user: Pick<UserSummary, "email" | "emailVerifiedAt"> | null) {
  return Boolean(user?.emailVerifiedAt && user.email.trim().toLowerCase() === ANALYTICS_EMAIL);
}

export function parseAnalyticsPagination(url: URL) {
  const readInteger = (name: string, fallback: number) => {
    const values = url.searchParams.getAll(name);
    if (!values.length) return fallback;
    const value = Number(values[0]);
    if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0]) || !Number.isSafeInteger(value)) {
      throw new HttpError(400, "Некоректні параметри пагінації");
    }
    return value;
  };
  const page = readInteger("page", 1);
  const pageSize = readInteger("pageSize", 20);
  if (!PAGE_SIZES.has(pageSize)) throw new HttpError(400, "Розмір сторінки має бути 10, 20, 50 або 100");
  return { page, pageSize };
}

type Totals = { totalUsers: number; totalWords: number; totalLists: number };
type RegisteredUser = { id: string; email: string; registeredAt: string };
type AnalyticsUser = RegisteredUser & {
  lastLoginAt: string | null;
  loginCount: number;
  wordCount: number;
  listCount: number;
};

export async function getAnalytics(db: D1Database, requestedPage: number, pageSize: number) {
  // D1 batches run transactionally: all totals and rows describe the same
  // snapshot, including when registrations/deletions happen during a request.
  // Independent counts avoid multiplying lists by their joined word rows.
  const [totalsResult, latestResult, usersResult] = await db.batch([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM users) AS totalUsers,
      (SELECT COUNT(*) FROM words) AS totalWords,
      (SELECT COUNT(*) FROM word_lists) AS totalLists`),
    db.prepare(`SELECT id, email, created_at AS registeredAt FROM users ORDER BY created_at DESC, id DESC LIMIT 1`),
    db.prepare(`SELECT u.id, u.email, u.created_at AS registeredAt,
      u.last_login_at AS lastLoginAt, u.login_count AS loginCount,
      (SELECT COUNT(*) FROM word_lists l WHERE l.user_id = u.id) AS listCount,
      (SELECT COUNT(*) FROM words w JOIN word_lists l ON l.id = w.list_id WHERE l.user_id = u.id) AS wordCount
      FROM users u ORDER BY u.created_at DESC, u.id DESC
      LIMIT ? OFFSET (
        SELECT MAX(0, MIN(?, CAST((COUNT(*) - 1) / ? AS INTEGER))) * ? FROM users
      )`).bind(pageSize, requestedPage - 1, pageSize, pageSize)
  ]);
  const totals = totalsResult.results[0] as Totals;
  const totalUsers = Number(totals.totalUsers);
  const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize));
  return {
    summary: {
      totalUsers,
      latestRegisteredUser: (latestResult.results[0] as RegisteredUser | undefined) ?? null,
      totalWords: Number(totals.totalWords),
      totalLists: Number(totals.totalLists)
    },
    users: (usersResult.results as AnalyticsUser[]).map((user) => ({
      ...user,
      loginCount: Number(user.loginCount),
      wordCount: Number(user.wordCount),
      listCount: Number(user.listCount)
    })),
    pagination: { page: Math.min(requestedPage, totalPages), pageSize, totalItems: totalUsers, totalPages }
  };
}
