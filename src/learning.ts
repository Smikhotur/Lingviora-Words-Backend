import { calculateReviewState, checkAnswer } from "./learning-core";
import { HttpError } from "./http";
import { normalizePronunciationTranscription } from "./pronunciation";
import type { LearningCard, LearningMode } from "./types";

type StudyWord = {
  id: string; listId: string; term: string; translation: string; example: string | null; exampleTranslation: string | null;
  transcription: string | null; pronunciationAudioUrl: string | null;
  status: "new" | "learning" | "learned"; repetitions: number; correctStreak: number; correctCount: number;
  attemptCount: number; easeFactor: number; intervalDays: number; practicedModes: number; sourceLanguage: string; targetLanguage: string;
};

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

async function getProgress(db: D1Database, listId: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'learned' THEN 1 ELSE 0 END), 0) AS learned, COALESCE(SUM(CASE WHEN status = 'new' OR next_review_at <= ? THEN 1 ELSE 0 END), 0) AS due FROM words WHERE list_id = ?`).bind(new Date().toISOString(), listId).first<{ total: number; learned: number; due: number }>();
  return { total: Number(row?.total ?? 0), learned: Number(row?.learned ?? 0), due: Number(row?.due ?? 0) };
}

export async function getNextLearningCard(db: D1Database, userId: string, listId: string): Promise<LearningCard | null> {
  const word = await db.prepare(`SELECT w.id, w.list_id AS listId, w.term, w.translation, w.transcription, w.pronunciation_audio_url AS pronunciationAudioUrl, w.example, w.example_translation AS exampleTranslation, w.status, w.repetitions, w.correct_streak AS correctStreak, w.correct_count AS correctCount, w.attempt_count AS attemptCount, w.ease_factor AS easeFactor, w.interval_days AS intervalDays, w.practiced_modes AS practicedModes, l.source_language AS sourceLanguage, l.target_language AS targetLanguage FROM words w JOIN word_lists l ON l.id = w.list_id WHERE w.list_id = ? AND l.user_id = ? AND (w.status = 'new' OR w.next_review_at <= ?) ORDER BY CASE w.status WHEN 'learning' THEN 0 WHEN 'new' THEN 1 ELSE 2 END, w.next_review_at ASC, w.attempt_count ASC LIMIT 1`).bind(listId, userId, new Date().toISOString()).first<StudyWord>();
  if (!word) return null;
  const alternatives = await db.prepare(`SELECT translation FROM words WHERE list_id = ? AND id != ? AND translation != ? ORDER BY RANDOM() LIMIT 3`).bind(listId, word.id, word.translation).all<{ translation: string }>();
  const mode = chooseMode(word, alternatives.results.length);
  const progress = await getProgress(db, listId);
  const pronunciation = { sourceLanguage: word.sourceLanguage, transcription: normalizePronunciationTranscription(word.transcription), pronunciationAudioUrl: word.pronunciationAudioUrl };
  if (mode === "choice") return { wordId: word.id, mode, prompt: word.term, instruction: `Оберіть переклад · ${word.targetLanguage}`, options: shuffle([word.translation, ...alternatives.results.map((item) => item.translation)]), ...pronunciation, progress };
  if (mode === "sentence" && word.example) return { wordId: word.id, mode, prompt: word.example.replace(new RegExp(termPattern(word.term), "giu"), "_____"), instruction: `Вставте пропущене слово · ${word.sourceLanguage}`, exampleTranslation: word.exampleTranslation, ...pronunciation, progress };
  return { wordId: word.id, mode: "typing", prompt: word.translation, instruction: `Напишіть слово · ${word.sourceLanguage}`, ...pronunciation, progress };
}

export async function recordAnswer(db: D1Database, userId: string, wordId: string, mode: LearningMode, answer: string) {
  const word = await db.prepare(`SELECT w.id, w.term, w.translation, w.repetitions, w.correct_streak AS correctStreak, w.correct_count AS correctCount, w.attempt_count AS attemptCount, w.ease_factor AS easeFactor, w.interval_days AS intervalDays, w.practiced_modes AS practicedModes FROM words w JOIN word_lists l ON l.id = w.list_id WHERE w.id = ? AND l.user_id = ? LIMIT 1`).bind(wordId, userId).first<StudyWord>();
  if (!word) throw new HttpError(404, "Слово не знайдено");
  const expected = mode === "choice" ? word.translation : word.term;
  const correct = checkAnswer(answer, expected);
  const now = new Date();
  const review = calculateReviewState(word, correct, mode, now);
  await db.batch([
    db.prepare(`UPDATE words SET status = ?, repetitions = ?, correct_streak = ?, correct_count = ?, attempt_count = ?, ease_factor = ?, interval_days = ?, practiced_modes = ?, next_review_at = ?, last_reviewed_at = ?, updated_at = ? WHERE id = ?`).bind(review.status, review.repetitions, review.correctStreak, review.correctCount, review.attemptCount, review.easeFactor, review.intervalDays, review.practicedModes, review.nextReviewAt.toISOString(), now.toISOString(), now.toISOString(), word.id),
    db.prepare(`INSERT INTO learning_attempts (id, user_id, word_id, mode, answer, is_correct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), userId, word.id, mode, answer, correct ? 1 : 0, now.toISOString())
  ]);
  return { correct, expected, status: review.status, nextReviewAt: review.nextReviewAt.toISOString() };
}

export async function markWordKnown(db: D1Database, userId: string, wordId: string) {
  const row = await db.prepare(`SELECT w.id FROM words w JOIN word_lists l ON l.id = w.list_id WHERE w.id = ? AND l.user_id = ? LIMIT 1`).bind(wordId, userId).first<{ id: string }>();
  if (!row) throw new HttpError(404, "Слово не знайдено");
  const now = new Date();
  await db.batch([
    db.prepare(`UPDATE words SET status = 'learned', repetitions = MAX(repetitions, 4), correct_streak = MAX(correct_streak, 4), interval_days = 30, practiced_modes = 7, next_review_at = ?, last_reviewed_at = ?, updated_at = ? WHERE id = ?`).bind(new Date(now.getTime() + 30 * 86_400_000).toISOString(), now.toISOString(), now.toISOString(), wordId),
    db.prepare(`INSERT INTO learning_attempts (id, user_id, word_id, mode, answer, is_correct, created_at) VALUES (?, ?, ?, 'known', NULL, 1, ?)`).bind(crypto.randomUUID(), userId, wordId, now.toISOString())
  ]);
}
