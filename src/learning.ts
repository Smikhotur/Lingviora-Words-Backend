import { calculateReviewState, checkAnswer, normalizeAnswer, REQUIRED_CORRECT_STREAK } from "./learning-core";
import { HttpError } from "./http";
import { normalizePronunciationTranscription } from "./pronunciation";
import { ownsList } from "./repository";
import { isEnglishLanguage } from "./languages";
import { ttsAudioPath } from "./tts";
import type { LearningCard, LearningMode, LearningProgress } from "./types";

type StudyWord = {
  id: string; listId: string; term: string; translation: string; example: string | null; exampleTranslation: string | null;
  transcription: string | null; pronunciationAudioUrl: string | null;
  status: "new" | "learning" | "learned"; repetitions: number; correctStreak: number; correctCount: number;
  attemptCount: number; easeFactor: number; intervalDays: number; practicedModes: number; sourceLanguage: string; targetLanguage: string;
  nextReviewAt: string; updatedAt: string;
};

const WORD_COLUMNS = `w.id, w.list_id AS listId, w.term, w.translation, w.transcription, w.pronunciation_audio_url AS pronunciationAudioUrl, w.example, w.example_translation AS exampleTranslation, w.status, w.repetitions, w.correct_streak AS correctStreak, w.correct_count AS correctCount, w.attempt_count AS attemptCount, w.ease_factor AS easeFactor, w.interval_days AS intervalDays, w.practiced_modes AS practicedModes, w.next_review_at AS nextReviewAt, w.updated_at AS updatedAt, l.source_language AS sourceLanguage, l.target_language AS targetLanguage`;
const STALE_REVIEW_MESSAGE = "Слово вже оновлено. Завантажте наступне завдання.";

function shuffle<T>(values: T[]) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function termPattern(term: string) {
  return `(?<![\\p{L}\\p{N}_])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`;
}

function hasExample(word: StudyWord) {
  return Boolean(word.example && new RegExp(termPattern(word.term), "iu").test(word.example));
}

function chooseMode(word: StudyWord, distractors: number): LearningMode {
  const rotation: LearningMode[] = ["choice", "typing", "sentence"];
  let mode = rotation[word.attemptCount % rotation.length];
  if (mode === "choice" && distractors < 1) mode = "typing";
  if (mode === "sentence" && !hasExample(word)) mode = "typing";
  return mode;
}

export async function getLearningProgress(db: D1Database, userId: string, listId: string): Promise<LearningProgress> {
  if (!(await ownsList(db, userId, listId))) throw new HttpError(404, "Список не знайдено");
  const now = new Date().toISOString();
  const row = await db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN status = 'learned' THEN 1 ELSE 0 END), 0) AS learned,
    COALESCE(SUM(CASE WHEN status != 'learned' AND (status = 'new' OR next_review_at <= ?) THEN 1 ELSE 0 END), 0) AS due,
    COALESCE(SUM(CASE WHEN status = 'learning' THEN 1 ELSE 0 END), 0) AS learning,
    COALESCE(SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END), 0) AS new,
    MIN(CASE WHEN status = 'learning' AND next_review_at > ? THEN next_review_at END) AS nextReviewAt
    FROM words WHERE list_id = ?`).bind(now, now, listId).first<LearningProgress>();
  return {
    total: Number(row?.total ?? 0), learned: Number(row?.learned ?? 0), due: Number(row?.due ?? 0),
    learning: Number(row?.learning ?? 0), new: Number(row?.new ?? 0), nextReviewAt: row?.nextReviewAt ?? null
  };
}

async function getStudyWord(db: D1Database, userId: string, wordId: string) {
  const word = await db.prepare(`SELECT ${WORD_COLUMNS} FROM words w JOIN word_lists l ON l.id = w.list_id WHERE w.id = ? AND l.user_id = ? LIMIT 1`).bind(wordId, userId).first<StudyWord>();
  if (!word) throw new HttpError(404, "Слово не знайдено");
  return word;
}

async function getAlternatives(db: D1Database, word: StudyWord) {
  const rows = await db.prepare(`SELECT DISTINCT translation FROM words WHERE list_id = ? AND id != ? AND translation != ?`).bind(word.listId, word.id, word.translation).all<{ translation: string }>();
  const seen = new Set([normalizeAnswer(word.translation)]);
  return rows.results.map((row) => row.translation).filter((translation) => {
    const normalized = normalizeAnswer(translation);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function assertCurrentRevision(word: StudyWord, revision?: number) {
  if (revision !== undefined && revision !== word.attemptCount) throw new HttpError(409, STALE_REVIEW_MESSAGE);
}

export async function getNextLearningCard(db: D1Database, userId: string, listId: string): Promise<LearningCard | null> {
  const progress = await getLearningProgress(db, userId, listId);
  const word = await db.prepare(`SELECT ${WORD_COLUMNS} FROM words w JOIN word_lists l ON l.id = w.list_id WHERE w.list_id = ? AND l.user_id = ? AND w.status != 'learned' AND (w.status = 'new' OR w.next_review_at <= ?) ORDER BY CASE w.status WHEN 'learning' THEN 0 ELSE 1 END, w.next_review_at ASC, w.attempt_count ASC, w.id ASC LIMIT 1`).bind(listId, userId, new Date().toISOString()).first<StudyWord>();
  if (!word) return null;
  const alternatives = await getAlternatives(db, word);
  const mode = chooseMode(word, alternatives.length);
  const common = {
    wordId: word.id, revision: word.attemptCount, correctStreak: word.correctStreak, requiredStreak: REQUIRED_CORRECT_STREAK,
    sourceLanguage: word.sourceLanguage, transcription: normalizePronunciationTranscription(word.transcription), pronunciationAudioUrl: isEnglishLanguage(word.sourceLanguage) ? ttsAudioPath(word.id) : word.pronunciationAudioUrl, progress
  };
  if (mode === "choice") return { ...common, mode, prompt: word.term, instruction: `Оберіть переклад · ${word.targetLanguage}`, options: shuffle([word.translation, ...shuffle(alternatives).slice(0, 3)]) };
  if (mode === "sentence" && word.example) return { ...common, mode, prompt: word.example.replace(new RegExp(termPattern(word.term), "giu"), "_____"), instruction: `Вставте пропущене слово · ${word.sourceLanguage}`, exampleTranslation: word.exampleTranslation };
  return { ...common, mode: "typing", prompt: word.translation, instruction: `Напишіть слово · ${word.sourceLanguage}` };
}

export async function recordAnswer(db: D1Database, userId: string, wordId: string, mode: LearningMode, answer: string, revision?: number) {
  const word = await getStudyWord(db, userId, wordId);
  assertCurrentRevision(word, revision);
  const now = new Date();
  const nowIso = now.toISOString();
  if (word.status === "learned" || (word.status !== "new" && word.nextReviewAt > nowIso)) throw new HttpError(409, STALE_REVIEW_MESSAGE);
  const alternatives = await getAlternatives(db, word);
  if (mode !== chooseMode(word, alternatives.length)) throw new HttpError(409, STALE_REVIEW_MESSAGE);
  const expected = mode === "choice" ? word.translation : word.term;
  const correct = checkAnswer(answer, expected, mode);
  const review = calculateReviewState(word, correct, mode, now);
  const attemptId = crypto.randomUUID();
  // D1 batches are transactional: only the request matching the current revision
  // inserts an attempt, and only that attempt may advance the word in this batch.
  const results = await db.batch([
    db.prepare(`INSERT INTO learning_attempts (id, user_id, word_id, mode, answer, is_correct, created_at)
      SELECT ?, ?, id, ?, ?, ?, ? FROM words
      WHERE id = ? AND attempt_count = ? AND updated_at = ? AND status != 'learned' AND (status = 'new' OR next_review_at <= ?)`)
      .bind(attemptId, userId, mode, answer, correct ? 1 : 0, nowIso, word.id, word.attemptCount, word.updatedAt, nowIso),
    db.prepare(`UPDATE words SET status = ?, repetitions = ?, correct_streak = ?, correct_count = ?, attempt_count = ?, ease_factor = ?, interval_days = ?, practiced_modes = ?, next_review_at = ?, last_reviewed_at = ?, updated_at = ?
      WHERE id = ? AND attempt_count = ? AND EXISTS (SELECT 1 FROM learning_attempts WHERE id = ?)`)
      .bind(review.status, review.repetitions, review.correctStreak, review.correctCount, review.attemptCount, review.easeFactor, review.intervalDays, review.practicedModes, review.nextReviewAt.toISOString(), nowIso, nowIso, word.id, word.attemptCount, attemptId)
  ]);
  if (!results[1].meta.changes) throw new HttpError(409, STALE_REVIEW_MESSAGE);
  return {
    correct, expected, status: review.status, nextReviewAt: review.nextReviewAt.toISOString(),
    correctStreak: review.correctStreak, requiredStreak: REQUIRED_CORRECT_STREAK,
    progress: await getLearningProgress(db, userId, word.listId)
  };
}

export async function markWordKnown(db: D1Database, userId: string, wordId: string, revision?: number) {
  const word = await getStudyWord(db, userId, wordId);
  assertCurrentRevision(word, revision);
  if (word.status === "learned") return { ok: true, progress: await getLearningProgress(db, userId, word.listId) };
  const now = new Date();
  const nowIso = now.toISOString();
  const attemptId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(`INSERT INTO learning_attempts (id, user_id, word_id, mode, answer, is_correct, created_at)
      SELECT ?, ?, id, 'known', NULL, 1, ? FROM words WHERE id = ? AND attempt_count = ? AND status != 'learned'`)
      .bind(attemptId, userId, nowIso, wordId, word.attemptCount),
    db.prepare(`UPDATE words SET status = 'learned', attempt_count = attempt_count + 1, interval_days = 30, next_review_at = ?, last_reviewed_at = ?, updated_at = ?
      WHERE id = ? AND attempt_count = ? AND EXISTS (SELECT 1 FROM learning_attempts WHERE id = ?)`)
      .bind(new Date(now.getTime() + 30 * 86_400_000).toISOString(), nowIso, nowIso, wordId, word.attemptCount, attemptId)
  ]);
  if (!results[1].meta.changes) throw new HttpError(409, STALE_REVIEW_MESSAGE);
  return { ok: true, progress: await getLearningProgress(db, userId, word.listId) };
}

export async function resetWordLearning(db: D1Database, userId: string, wordId: string, revision?: number) {
  const word = await getStudyWord(db, userId, wordId);
  assertCurrentRevision(word, revision);
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE words SET status = 'new', repetitions = 0, correct_streak = 0, attempt_count = attempt_count + 1, ease_factor = 250, interval_days = 0, practiced_modes = 0, next_review_at = ?, last_reviewed_at = NULL, updated_at = ? WHERE id = ? AND attempt_count = ?`)
    .bind(now, now, wordId, word.attemptCount).run();
  if (!result.meta.changes) throw new HttpError(409, STALE_REVIEW_MESSAGE);
  return { ok: true, progress: await getLearningProgress(db, userId, word.listId) };
}
