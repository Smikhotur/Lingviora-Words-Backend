import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createSession } from "../src/auth";
import { HttpError } from "../src/http";
import worker from "../src/index";
import { getLearningProgress, getNextLearningCard, markWordKnown, recordAnswer, resetWordLearning } from "../src/learning";
import { getList, getLists } from "../src/repository";
import type { Env } from "../src/types";

// Execute production SQL against the real schema. The adapter only translates
// D1's prepared-statement API and preserves its transactional batch semantics.
function sqliteD1(sqlite: DatabaseSync) {
  const makeStatement = (sql: string, params: SQLInputValue[] = []) => ({
    bind(...values: SQLInputValue[]) { return makeStatement(sql, values); },
    async first<T>() { return (sqlite.prepare(sql).get(...params) ?? null) as T | null; },
    async all<T>() { return { results: sqlite.prepare(sql).all(...params) as T[], success: true }; },
    execute() {
      const result = sqlite.prepare(sql).run(...params);
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
    async run() { return this.execute(); }
  });
  return {
    prepare: makeStatement,
    async batch(statements: ReturnType<typeof makeStatement>[]) {
      sqlite.exec("BEGIN TRANSACTION");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  } as unknown as D1Database;
}

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../drizzle/0000_sparkling_avengers.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../drizzle/0001_omniscient_invisible_woman.sql", import.meta.url), "utf8"));
  const db = sqliteD1(sqlite);
  const userId = crypto.randomUUID();
  const listId = crypto.randomUUID();
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, email_verified_at, created_at, updated_at) VALUES (?, ?, '', '', ?, ?, ?)")
    .run(userId, "learner@example.com", now, now, now);
  sqlite.prepare("INSERT INTO word_lists (id, user_id, name, source_language, target_language, created_at, updated_at) VALUES (?, ?, 'Lesson', 'en', 'uk', ?, ?)")
    .run(listId, userId, now, now);
  const addWord = (term = "contact", translation = "контакт, зв’язок; зв’язуватися") => {
    const id = crypto.randomUUID();
    sqlite.prepare("INSERT INTO words (id, list_id, term, translation, next_review_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, listId, term, translation, now, now, now);
    return id;
  };
  const wordState = (id: string) => sqlite.prepare("SELECT * FROM words WHERE id = ?").get(id)!;
  const attempts = () => Number(sqlite.prepare("SELECT COUNT(*) AS count FROM learning_attempts").get()!.count);
  const env: Env = { DB: db, APP_ENV: "test", ALLOWED_ORIGINS: "https://app.example.com" };
  const authenticatedRequest = async (path: string, method = "GET", body?: unknown) => {
    const base = new Request(`https://api.example.com${path}`);
    const cookie = await createSession(db, userId, base, env);
    return new Request(base, { method, headers: { cookie: cookie.split(";")[0], origin: "https://app.example.com", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  return { sqlite, db, userId, listId, addWord, wordState, attempts, env, authenticatedRequest };
}

function isConflict(error: unknown) {
  return error instanceof HttpError && error.status === 409;
}

test("compound choice is accepted and learning progress is returned immediately", async (t) => {
  const f = fixture(t);
  const id = f.addWord();
  f.addWord("invent", "винаходити, вигадувати");
  const result = await recordAnswer(f.db, f.userId, id, "choice", "контакт, зв’язок; зв’язуватися", 0);
  assert.equal(result.correct, true);
  assert.equal(result.correctStreak, 1);
  assert.equal(result.requiredStreak, 4);
  assert.deepEqual({ ...result.progress, nextReviewAt: null }, { total: 2, learned: 0, due: 1, learning: 1, new: 1, nextReviewAt: null });
  assert.equal(result.progress.nextReviewAt, result.nextReviewAt);
  assert.equal(f.attempts(), 1);
});

test("simultaneous duplicate submissions advance and log a word only once", async (t) => {
  const f = fixture(t);
  const id = f.addWord();
  const results = await Promise.allSettled([
    recordAnswer(f.db, f.userId, id, "typing", "contact", 0),
    recordAnswer(f.db, f.userId, id, "typing", "contact", 0)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && isConflict(rejected.reason));
  assert.equal(f.wordState(id).attempt_count, 1);
  assert.equal(f.wordState(id).correct_streak, 1);
  assert.equal(f.attempts(), 1);
  await assert.rejects(recordAnswer(f.db, f.userId, id, "typing", "contact"), isConflict);
});

test("a failed atomic review never leaves an orphan history entry", async (t) => {
  const f = fixture(t);
  const id = f.addWord();
  f.sqlite.exec("CREATE TRIGGER reject_review BEFORE UPDATE ON words BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
  await assert.rejects(recordAnswer(f.db, f.userId, id, "typing", "contact", 0), /simulated write failure/);
  assert.equal(f.wordState(id).attempt_count, 0);
  assert.equal(f.attempts(), 0);
});

test("the server rejects a forged mode and old revisions even when the word is due", async (t) => {
  const f = fixture(t);
  const id = f.addWord();
  f.addWord("invent", "винаходити");
  await assert.rejects(recordAnswer(f.db, f.userId, id, "typing", "contact", 0), isConflict);
  await recordAnswer(f.db, f.userId, id, "choice", "контакт, зв’язок; зв’язуватися", 0);
  f.sqlite.prepare("UPDATE words SET next_review_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  await assert.rejects(recordAnswer(f.db, f.userId, id, "typing", "contact", 0), isConflict);
  assert.equal(f.wordState(id).attempt_count, 1);
});

test("four scheduled typing recalls graduate a single-word list and keep it archived", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
  const f = fixture(t);
  const id = f.addWord();
  const intervals = [1, 3, 7, 19];
  for (let index = 0; index < 4; index += 1) {
    const card = await getNextLearningCard(f.db, f.userId, f.listId);
    assert.equal(card?.revision, index);
    assert.equal(card?.mode, "typing");
    const result = await recordAnswer(f.db, f.userId, id, "typing", "contact", card!.revision);
    assert.equal(result.correct, true);
    assert.equal(result.correctStreak, index + 1);
    assert.equal(result.status, index === 3 ? "learned" : "learning");
    assert.equal(f.wordState(id).interval_days, intervals[index]);
    assert.equal(await getNextLearningCard(f.db, f.userId, f.listId), null);
    assert.equal((await getLearningProgress(f.db, f.userId, f.listId)).due, 0);
    t.mock.timers.setTime(new Date(result.nextReviewAt).getTime());
  }
  assert.equal((await getLearningProgress(f.db, f.userId, f.listId)).learned, 1);
  assert.equal((await getLearningProgress(f.db, f.userId, f.listId)).nextReviewAt, null);
  assert.equal(await getNextLearningCard(f.db, f.userId, f.listId), null, "learned word stays out even after its old review date");
  assert.equal((await getLists(f.db, f.userId))[0].dueCount, 0);
  assert.equal((await getList(f.db, f.userId, f.listId)).words.length, 1, "mastery never deletes the word");
  assert.equal(f.attempts(), 4);
});

test("a mistake clears current mastery and only becomes due after ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
  const f = fixture(t);
  const id = f.addWord();
  const first = await recordAnswer(f.db, f.userId, id, "typing", "contact", 0);
  t.mock.timers.setTime(new Date(first.nextReviewAt).getTime());
  const incorrect = await recordAnswer(f.db, f.userId, id, "typing", "contakt", 1);
  assert.equal(incorrect.correct, false);
  assert.equal(incorrect.correctStreak, 0);
  assert.equal(f.wordState(id).practiced_modes, 0);
  assert.equal(f.wordState(id).correct_count, 1, "lifetime count is retained");
  t.mock.timers.setTime(new Date(incorrect.nextReviewAt).getTime() - 1);
  assert.equal(await getNextLearningCard(f.db, f.userId, f.listId), null);
  await assert.rejects(recordAnswer(f.db, f.userId, id, "typing", "contact", 2), isConflict);
  t.mock.timers.setTime(new Date(incorrect.nextReviewAt).getTime());
  assert.equal((await getNextLearningCard(f.db, f.userId, f.listId))?.wordId, id);
});

test("known and restore preserve word history and monotonically advance revisions", async (t) => {
  const f = fixture(t);
  const id = f.addWord();
  await recordAnswer(f.db, f.userId, id, "typing", "contact", 0);
  const known = await markWordKnown(f.db, f.userId, id, 1);
  assert.equal(known.progress.learned, 1);
  assert.equal(known.progress.due, 0);
  assert.equal(f.wordState(id).attempt_count, 2);
  assert.equal(f.wordState(id).correct_streak, 1, "manual mastery does not invent successful recalls");
  const reset = await resetWordLearning(f.db, f.userId, id, 2);
  assert.equal(reset.progress.learned, 0);
  assert.equal(reset.progress.new, 1);
  assert.equal(reset.progress.due, 1);
  assert.equal(f.wordState(id).attempt_count, 3);
  assert.equal(f.wordState(id).correct_streak, 0);
  assert.equal(f.wordState(id).correct_count, 1);
  assert.equal(f.attempts(), 2);
  await assert.rejects(recordAnswer(f.db, f.userId, id, "typing", "contact", 0), isConflict);
  await assert.rejects(resetWordLearning(f.db, f.userId, id, 2), isConflict);
});

test("simultaneous known actions are recorded once", async (t) => {
  const f = fixture(t);
  const id = f.addWord();
  const results = await Promise.allSettled([markWordKnown(f.db, f.userId, id, 0), markWordKnown(f.db, f.userId, id, 0)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(f.wordState(id).attempt_count, 1);
  assert.equal(f.attempts(), 1);
});

test("choices contain unique normalized translations", async (t) => {
  const f = fixture(t);
  f.addWord("contact", "зв’язок");
  f.addWord("connection", "зв'язок");
  f.addWord("link", "звʼязок");
  const card = await getNextLearningCard(f.db, f.userId, f.listId);
  assert.equal(card?.mode, "typing", "equivalent labels cannot become false choice distractors");
});

test("session returns progress for an empty queue and rejects foreign lists", async (t) => {
  const f = fixture(t);
  const request = await f.authenticatedRequest(`/api/learn/session?listId=${f.listId}`);
  const response = await worker.fetch(request, f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { card: null, progress: { total: 0, learned: 0, due: 0, learning: 0, new: 0, nextReviewAt: null } });
  await assert.rejects(getLearningProgress(f.db, "another-user", f.listId), (error: unknown) => error instanceof HttpError && error.status === 404);
  const missing = await worker.fetch(await f.authenticatedRequest(`/api/learn/session?listId=${crypto.randomUUID()}`), f.env);
  assert.equal(missing.status, 404);
});

test("reset endpoint requires authentication, trusted origin, and the current revision", async (t) => {
  const f = fixture(t);
  const wordId = f.addWord();
  await markWordKnown(f.db, f.userId, wordId, 0);
  const unauthenticated = await worker.fetch(new Request("https://api.example.com/api/learn/reset", { method: "POST" }), f.env);
  assert.equal(unauthenticated.status, 401);
  const unsafe = await f.authenticatedRequest("/api/learn/reset", "POST", { wordId, revision: 1 });
  unsafe.headers.set("origin", "https://untrusted.example.com");
  assert.equal((await worker.fetch(unsafe, f.env)).status, 403);
  const stale = await worker.fetch(await f.authenticatedRequest("/api/learn/reset", "POST", { wordId, revision: 0 }), f.env);
  assert.equal(stale.status, 409);
  const reset = await worker.fetch(await f.authenticatedRequest("/api/learn/reset", "POST", { wordId, revision: 1 }), f.env);
  assert.equal(reset.status, 200);
  assert.equal(f.wordState(wordId).status, "new");
});

test("changing a translation resets mastery and invalidates any previously issued card", async (t) => {
  const f = fixture(t);
  const wordId = f.addWord();
  // Existing pronunciation avoids any external dictionary request during the test.
  f.sqlite.prepare("UPDATE words SET transcription = '/ˈkɒntækt/' WHERE id = ?").run(wordId);
  await markWordKnown(f.db, f.userId, wordId, 0);
  const response = await worker.fetch(await f.authenticatedRequest(`/api/words/${wordId}`, "PATCH", { term: "contact", translation: "контакт" }), f.env);
  assert.equal(response.status, 200);
  assert.equal(f.wordState(wordId).status, "new");
  assert.equal(f.wordState(wordId).correct_streak, 0);
  assert.equal(f.wordState(wordId).attempt_count, 2);
  await assert.rejects(recordAnswer(f.db, f.userId, wordId, "typing", "contact", 0), isConflict);
});
