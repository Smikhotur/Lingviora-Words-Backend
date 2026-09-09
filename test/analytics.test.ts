import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { canViewAnalytics, getAnalytics } from "../src/analytics";
import { createSession } from "../src/auth";
import { createPasswordHash } from "../src/crypto";
import { createEmailToken } from "../src/email-tokens";
import worker from "../src/index";
import type { Env } from "../src/types";

const NOW = "2026-01-01T00:00:00.000Z";
const OWNER = "smikhotur@gmail.com";
const PASSWORD = "test-password-123456";

// Real SQLite, with D1's prepared statements and atomic batch behavior. The
// query log also proves rejected requests never read the analytics tables.
function sqliteD1(sqlite: DatabaseSync, queries: string[]) {
  const prepare = (sql: string, params: SQLInputValue[] = []) => ({
    bind(...values: SQLInputValue[]) { return prepare(sql, values); },
    async first<T>() {
      queries.push(sql);
      return (sqlite.prepare(sql).get(...params) ?? null) as T | null;
    },
    execute() {
      queries.push(sql);
      const statement = sqlite.prepare(sql);
      if (statement.columns().length) return { results: statement.all(...params), success: true, meta: { changes: 0 } };
      const result = statement.run(...params);
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
    async all() { return this.execute(); },
    async run() { return this.execute(); }
  });
  return {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
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

function fixture(t: TestContext, migrateAnalytics = true) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const migrations = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    if (!migrateAnalytics && file.startsWith("0002_")) continue;
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const queries: string[] = [];
  const db = sqliteD1(sqlite, queries);
  const env: Env = { DB: db, APP_ENV: "test", APP_BASE_URL: "https://app.example.com", ALLOWED_ORIGINS: "https://app.example.com", ALLOW_TEST_MAILBOX: "true" };
  const addUser = (id: string, email = `${id}@example.com`, verified: string | null = NOW, registeredAt = NOW) => {
    sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, email_verified_at, created_at, updated_at) VALUES (?, ?, '', '', ?, ?, ?)")
      .run(id, email, verified, registeredAt, registeredAt);
    return id;
  };
  const addList = (id: string, userId: string) => {
    sqlite.prepare("INSERT INTO word_lists (id, user_id, name, source_language, target_language, created_at, updated_at) VALUES (?, ?, ?, 'en', 'uk', ?, ?)")
      .run(id, userId, id, NOW, NOW);
    return id;
  };
  const addWord = (id: string, listId: string, status = "new") => {
    sqlite.prepare("INSERT INTO words (id, list_id, term, translation, status, next_review_at, created_at, updated_at) VALUES (?, ?, ?, 'переклад', ?, ?, ?, ?)")
      .run(id, listId, id, status, NOW, NOW, NOW);
  };
  const request = (path: string, cookie?: string, body?: unknown) => new Request(`https://api.example.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: "https://app.example.com", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const cookieFor = async (userId: string) => (await createSession(db, userId, request("/"), env)).split(";")[0];
  const call = (path: string, cookie?: string, body?: unknown) => worker.fetch(request(path, cookie, body), env);
  const stats = (userId: string) => sqlite.prepare("SELECT login_count AS loginCount, last_login_at AS lastLoginAt FROM users WHERE id = ?").get(userId);
  const setPassword = async (userId: string) => {
    const password = await createPasswordHash(PASSWORD);
    sqlite.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?").run(password.hash, password.salt, userId);
  };
  return { sqlite, db, queries, env, addUser, addList, addWord, request, cookieFor, call, stats, setPassword };
}

async function payload(response: Response) {
  assert.equal(response.status, 200);
  return await response.json() as any;
}

test("analytics migration preserves existing users and defaults unknown login history honestly", (t) => {
  const f = fixture(t, false);
  f.addUser("existing", OWNER);
  f.sqlite.exec(readFileSync(new URL("../drizzle/0002_user_analytics.sql", import.meta.url), "utf8"));
  assert.deepEqual({ ...f.stats("existing") }, { loginCount: 0, lastLoginAt: null });
  assert.equal(f.sqlite.prepare("SELECT email FROM users WHERE id = 'existing'").get()!.email, OWNER);
  const queryPlan = f.sqlite.prepare("EXPLAIN QUERY PLAN SELECT id FROM users ORDER BY created_at DESC, id DESC LIMIT 20").all();
  assert.ok(queryPlan.some((row) => String(row.detail).includes("idx_users_created_id")));
});

test("analytics capability accepts only the verified exact normalized owner email", () => {
  assert.equal(canViewAnalytics(null), false);
  assert.equal(canViewAnalytics({ email: `  ${OWNER.toUpperCase()}  `, emailVerifiedAt: NOW }), true);
  for (const email of ["smikhotur+owner@gmail.com", "smikhotur@gmail.com.evil.example", "smikhotur@googlemail.com", "smikhоtur@gmail.com", "other@example.com"]) {
    assert.equal(canViewAnalytics({ email, emailVerifiedAt: NOW }), false, email);
  }
  assert.equal(canViewAnalytics({ email: OWNER, emailVerifiedAt: null }), false);
});

test("anonymous, expired, unverified and other-user requests cannot read any analytics", async (t) => {
  const f = fixture(t);
  f.addUser("owner", OWNER);
  f.addUser("other");
  f.addUser("unverified", "unverified@example.com", null);
  const ownerCookie = await f.cookieFor("owner");
  const otherCookie = await f.cookieFor("other");
  const unverifiedCookie = await f.cookieFor("unverified");
  f.sqlite.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = 'owner'").run(NOW);
  const cases: Array<[string | undefined, number]> = [[undefined, 401], ["lingviora_session=forged", 401], [ownerCookie, 401], [otherCookie, 403], [unverifiedCookie, 403]];
  for (const [cookie, expected] of cases) {
    f.queries.length = 0;
    const response = await f.call(`/api/analytics?email=${OWNER}&canViewAnalytics=true`, cookie);
    assert.equal(response.status, expected);
    assert.ok(f.queries.every((sql) => sql.includes("FROM sessions s JOIN users")), "only session verification may execute");
    const result = await response.json() as Record<string, unknown>;
    assert.equal(result.summary, undefined);
    assert.equal(result.users, undefined);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("pending owner email does not grant access; confirmation grants it and changing away revokes the existing session", async (t) => {
  const f = fixture(t);
  f.addUser("user", "learner@example.com");
  const cookie = await f.cookieFor("user");
  f.sqlite.prepare("UPDATE users SET pending_email = ? WHERE id = 'user'").run(OWNER);
  assert.equal((await payload(await f.call("/api/auth/me", cookie))).user.canViewAnalytics, false);
  assert.equal((await f.call("/api/analytics", cookie)).status, 403);
  const token = await createEmailToken(f.db, "user", OWNER, "change_email", 60_000);
  assert.equal((await f.call("/api/auth/verify-email", cookie, { token })).status, 200);
  assert.equal((await payload(await f.call("/api/auth/me", cookie))).user.canViewAnalytics, true);
  assert.equal((await f.call("/api/analytics", cookie)).status, 200);
  f.sqlite.prepare("UPDATE users SET pending_email = 'new@example.com' WHERE id = 'user'").run();
  assert.equal((await payload(await f.call("/api/auth/me", cookie))).user.canViewAnalytics, true, "current verified owner address still controls access");
  const changeAwayToken = await createEmailToken(f.db, "user", "new@example.com", "change_email", 60_000);
  assert.equal((await f.call("/api/auth/verify-email", cookie, { token: changeAwayToken })).status, 200);
  assert.equal((await payload(await f.call("/api/auth/me", cookie))).user.canViewAnalytics, false);
  assert.equal((await f.call("/api/analytics", cookie)).status, 403);
});

test("registration must verify ownership before the new owner account can see analytics", async (t) => {
  const f = fixture(t);
  f.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const response = await f.call("/api/auth/register", undefined, { email: ` ${OWNER.toUpperCase()} `, password: PASSWORD, captchaToken: "test-token" });
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  let user = (await payload(await f.call("/api/auth/me", cookie))).user;
  assert.equal(user.canViewAnalytics, false);
  assert.equal((await f.call("/api/analytics", cookie)).status, 403);
  assert.deepEqual({ ...f.stats(user.id) }, { loginCount: 0, lastLoginAt: null });
  const message = String(f.sqlite.prepare("SELECT text_body FROM email_outbox").get()!.text_body);
  const verificationUrl = new URL(message.match(/https:\/\/\S+/)![0]);
  assert.equal((await f.call("/api/auth/verify-email", cookie, { token: verificationUrl.searchParams.get("token") })).status, 200);
  user = (await payload(await f.call("/api/auth/me", cookie))).user;
  assert.equal(user.canViewAnalytics, true);
  assert.equal((await f.call("/api/analytics", cookie)).status, 200);
  assert.deepEqual({ ...f.stats(user.id) }, { loginCount: 0, lastLoginAt: null });
});

test("summary and per-user totals count stored words and lists once, including learned words and zero-activity users", async (t) => {
  const f = fixture(t);
  f.addUser("owner", OWNER, NOW, "2025-01-01T00:00:00.000Z");
  f.addUser("alice", "alice@example.com", NOW, "2025-05-01T00:00:00.000Z");
  f.addUser("bob", "bob@example.com", null, "2025-06-01T00:00:00.000Z");
  f.addList("alice-list-1", "alice");
  f.addList("alice-list-2", "alice");
  f.addList("bob-list", "bob");
  f.addWord("word-1", "alice-list-1");
  f.addWord("word-2", "alice-list-1", "learned");
  f.addWord("word-3", "alice-list-2", "learning");
  f.addWord("word-4", "bob-list");
  f.sqlite.prepare("UPDATE users SET login_count = 7, last_login_at = ? WHERE id = 'alice'").run(NOW);
  const cookie = await f.cookieFor("owner");
  const response = await f.call("/api/analytics", cookie);
  const result = await payload(response);
  assert.deepEqual(result.summary, { totalUsers: 3, latestRegisteredUser: { id: "bob", email: "bob@example.com", registeredAt: "2025-06-01T00:00:00.000Z" }, totalWords: 4, totalLists: 3 });
  assert.deepEqual(result.users.map((row: any) => [row.id, row.wordCount, row.listCount, row.loginCount, row.lastLoginAt]), [["bob", 1, 1, 0, null], ["alice", 3, 2, 7, NOW], ["owner", 0, 0, 0, null]]);
  assert.deepEqual(result.pagination, { page: 1, pageSize: 20, totalItems: 3, totalPages: 1 });
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const user of result.users) {
    assert.deepEqual(Object.keys(user).sort(), ["id", "email", "registeredAt", "lastLoginAt", "loginCount", "wordCount", "listCount"].sort());
  }
  f.sqlite.prepare("DELETE FROM words WHERE id = 'word-4'").run();
  f.sqlite.prepare("DELETE FROM word_lists WHERE id = 'alice-list-1'").run();
  const after = await payload(await f.call("/api/analytics", cookie));
  assert.equal(after.summary.totalWords, 1);
  assert.equal(after.summary.totalLists, 2);
});

test("pagination has stable registration ordering, accepts configured sizes, and clamps beyond the last page", async (t) => {
  const f = fixture(t);
  f.addUser("user-00", OWNER);
  for (let index = 1; index <= 42; index += 1) f.addUser(`user-${String(index).padStart(2, "0")}`);
  const cookie = await f.cookieFor("user-00");
  const first = await payload(await f.call("/api/analytics?page=1&pageSize=10", cookie));
  const second = await payload(await f.call("/api/analytics?page=2&pageSize=10", cookie));
  assert.deepEqual(first.users.map((row: any) => row.id), Array.from({ length: 10 }, (_, index) => `user-${42 - index}`));
  assert.deepEqual(second.users.map((row: any) => row.id), Array.from({ length: 10 }, (_, index) => `user-${32 - index}`));
  assert.equal(new Set([...first.users, ...second.users].map((row: any) => row.id)).size, 20);
  const last = await payload(await f.call(`/api/analytics?page=${Number.MAX_SAFE_INTEGER}&pageSize=10`, cookie));
  assert.deepEqual(last.pagination, { page: 5, pageSize: 10, totalItems: 43, totalPages: 5 });
  assert.deepEqual(last.users.map((row: any) => row.id), ["user-02", "user-01", "user-00"]);
  for (const pageSize of [20, 50, 100]) {
    const result = await payload(await f.call(`/api/analytics?pageSize=${pageSize}`, cookie));
    assert.equal(result.users.length, Math.min(43, pageSize));
    assert.equal(result.pagination.pageSize, pageSize);
  }
});

test("invalid pagination is rejected before aggregate queries run", async (t) => {
  const f = fixture(t);
  const cookie = await f.cookieFor(f.addUser("owner", OWNER));
  for (const query of ["page=0", "page=-1", "page=1.5", "page=1e2", "page=abc", "page=", "page=9007199254740992", "page=1&page=2", "pageSize=1", "pageSize=101", "pageSize=", "pageSize=20&pageSize=20", "pageSize=-20"]) {
    f.queries.length = 0;
    assert.equal((await f.call(`/api/analytics?${query}`, cookie)).status, 400, query);
    assert.equal(f.queries.length, 1);
    assert.ok(f.queries[0].includes("FROM sessions s JOIN users"));
  }
});

test("empty analytics data has zero totals, no latest registration and a valid first page", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await getAnalytics(f.db, 5, 20), {
    summary: { totalUsers: 0, latestRegisteredUser: null, totalWords: 0, totalLists: 0 },
    users: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 }
  });
});

test("successful explicit logins increment once each; session reads and logout leave counts unchanged", async (t) => {
  const f = fixture(t);
  f.addUser("owner", OWNER);
  await f.setPassword("owner");
  let cookie = "";
  for (let index = 1; index <= 2; index += 1) {
    const response = await f.call("/api/auth/login", undefined, { email: OWNER.toUpperCase(), password: PASSWORD });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.equal(f.stats("owner")!.loginCount, index);
    assert.ok(!Number.isNaN(Date.parse(String(f.stats("owner")!.lastLoginAt))));
  }
  for (let index = 0; index < 3; index += 1) await payload(await f.call("/api/auth/me", cookie));
  assert.equal((await f.call("/api/auth/logout", cookie, {})).status, 200);
  assert.equal(f.stats("owner")!.loginCount, 2);
});

test("failed login, invalid credentials, and an untrusted origin do not create sessions or record logins", async (t) => {
  const f = fixture(t);
  f.addUser("owner", OWNER);
  await f.setPassword("owner");
  for (const [email, password, expected] of [[OWNER, "wrong-password", 401], ["missing@example.com", PASSWORD, 401], ["invalid", PASSWORD, 400]] as const) {
    assert.equal((await f.call("/api/auth/login", undefined, { email, password })).status, expected);
  }
  const unsafe = f.request("/api/auth/login", undefined, { email: OWNER, password: PASSWORD });
  unsafe.headers.set("origin", "https://evil.example.com");
  assert.equal((await worker.fetch(unsafe, f.env)).status, 403);
  assert.deepEqual({ ...f.stats("owner") }, { loginCount: 0, lastLoginAt: null });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get()!.count, 0);
});

test("a successful unverified login is recorded but still has no analytics access", async (t) => {
  const f = fixture(t);
  f.addUser("owner", OWNER, null);
  await f.setPassword("owner");
  const response = await f.call("/api/auth/login", undefined, { email: OWNER, password: PASSWORD });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.equal(f.stats("owner")!.loginCount, 1);
  assert.equal((await payload(await f.call("/api/auth/me", cookie))).user.canViewAnalytics, false);
  assert.equal((await f.call("/api/analytics", cookie)).status, 403);
});

test("concurrent successful logins retain every increment", async (t) => {
  const f = fixture(t);
  f.addUser("owner", OWNER);
  await f.setPassword("owner");
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.call("/api/auth/login", undefined, { email: OWNER, password: PASSWORD })));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(f.stats("owner")!.loginCount, 6);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get()!.count, 6);
});

test("session creation and login tracking roll back together on a database failure", async (t) => {
  const f = fixture(t);
  f.addUser("owner", OWNER);
  f.sqlite.exec("CREATE TRIGGER reject_login BEFORE UPDATE OF login_count ON users BEGIN SELECT RAISE(ABORT, 'simulated login write failure'); END");
  await assert.rejects(createSession(f.db, "owner", f.request("/"), f.env, { recordLogin: true }), /simulated login write failure/);
  assert.deepEqual({ ...f.stats("owner") }, { loginCount: 0, lastLoginAt: null });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get()!.count, 0);
});

test("a delayed login cannot move the most recent login timestamp backwards", async (t) => {
  const f = fixture(t);
  f.addUser("owner", OWNER);
  const future = "2099-01-01T00:00:00.000Z";
  f.sqlite.prepare("UPDATE users SET last_login_at = ? WHERE id = 'owner'").run(future);
  await createSession(f.db, "owner", f.request("/"), f.env, { recordLogin: true });
  assert.deepEqual({ ...f.stats("owner") }, { loginCount: 1, lastLoginAt: future });
});

test("password reset and password change replace sessions without counting them as explicit logins", async (t) => {
  const f = fixture(t);
  f.addUser("owner", OWNER);
  await f.setPassword("owner");
  const oldCookie = await f.cookieFor("owner");
  const token = await createEmailToken(f.db, "owner", OWNER, "reset_password", 60_000);
  const resetResponse = await f.call("/api/auth/reset-password", undefined, { token, password: PASSWORD });
  assert.equal(resetResponse.status, 200);
  assert.equal((await payload(await f.call("/api/auth/me", oldCookie))).user, null);
  const resetCookie = resetResponse.headers.get("set-cookie")!.split(";")[0];
  const changeResponse = await f.call("/api/account/password", resetCookie, { currentPassword: PASSWORD, newPassword: "updated-password-123456" });
  assert.equal(changeResponse.status, 200);
  assert.equal((await payload(await f.call("/api/auth/me", resetCookie))).user, null);
  assert.deepEqual({ ...f.stats("owner") }, { loginCount: 0, lastLoginAt: null });
});
