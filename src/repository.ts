import { HttpError } from "./http";

export async function ownsList(db: D1Database, userId: string, listId: string) {
  return Boolean(await db.prepare("SELECT 1 AS found FROM word_lists WHERE id = ? AND user_id = ? LIMIT 1").bind(listId, userId).first());
}

export async function ownedWord(db: D1Database, userId: string, wordId: string) {
  return db.prepare(`SELECT w.id, w.list_id AS listId FROM words w JOIN word_lists l ON l.id = w.list_id WHERE w.id = ? AND l.user_id = ? LIMIT 1`).bind(wordId, userId).first<{ id: string; listId: string }>();
}

export async function getLists(db: D1Database, userId: string) {
  const result = await db.prepare(`SELECT l.id, l.name, l.source_language AS sourceLanguage, l.target_language AS targetLanguage, l.updated_at AS updatedAt, COUNT(w.id) AS wordCount, COALESCE(SUM(CASE WHEN w.status = 'learned' THEN 1 ELSE 0 END), 0) AS learnedCount, COALESCE(SUM(CASE WHEN w.status = 'new' OR w.next_review_at <= ? THEN 1 ELSE 0 END), 0) AS dueCount FROM word_lists l LEFT JOIN words w ON w.list_id = l.id WHERE l.user_id = ? GROUP BY l.id ORDER BY l.updated_at DESC`).bind(new Date().toISOString(), userId).all<Record<string, unknown>>();
  return result.results.map((row) => ({ ...row, wordCount: Number(row.wordCount), learnedCount: Number(row.learnedCount), dueCount: Number(row.dueCount) }));
}

export async function getList(db: D1Database, userId: string, listId: string) {
  const list = await db.prepare(`SELECT id, name, source_language AS sourceLanguage, target_language AS targetLanguage, updated_at AS updatedAt FROM word_lists WHERE id = ? AND user_id = ? LIMIT 1`).bind(listId, userId).first<Record<string, unknown>>();
  if (!list) throw new HttpError(404, "Список не знайдено");
  const words = await db.prepare(`SELECT id, list_id AS listId, term, translation, example, example_translation AS exampleTranslation, note, status, repetitions, correct_streak AS correctStreak, correct_count AS correctCount, attempt_count AS attemptCount, interval_days AS intervalDays, practiced_modes AS practicedModes, next_review_at AS nextReviewAt, updated_at AS updatedAt FROM words WHERE list_id = ? ORDER BY created_at DESC`).bind(listId).all<Record<string, unknown>>();
  return { ...list, words: words.results.map((word) => ({ ...word, repetitions: Number(word.repetitions), correctStreak: Number(word.correctStreak), correctCount: Number(word.correctCount), attemptCount: Number(word.attemptCount), intervalDays: Number(word.intervalDays), practicedModes: Number(word.practicedModes) })) };
}
