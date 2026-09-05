import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  pendingEmail: text("pending_email"),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  emailVerifiedAt: text("email_verified_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [uniqueIndex("uq_users_email").on(table.email), uniqueIndex("uq_users_pending_email").on(table.pendingEmail)]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [uniqueIndex("uq_sessions_token_hash").on(table.tokenHash), index("idx_sessions_user_expires").on(table.userId, table.expiresAt)]);

export const emailTokens = sqliteTable("email_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["verify_email", "change_email", "reset_password"] }).notNull(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull()
}, (table) => [uniqueIndex("uq_email_tokens_hash").on(table.tokenHash), index("idx_email_tokens_user_type").on(table.userId, table.type)]);

export const wordLists = sqliteTable("word_lists", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sourceLanguage: text("source_language").notNull(),
  targetLanguage: text("target_language").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [index("idx_word_lists_user_updated").on(table.userId, table.updatedAt)]);

export const words = sqliteTable("words", {
  id: text("id").primaryKey(),
  listId: text("list_id").notNull().references(() => wordLists.id, { onDelete: "cascade" }),
  term: text("term").notNull(),
  translation: text("translation").notNull(),
  example: text("example"),
  exampleTranslation: text("example_translation"),
  note: text("note"),
  status: text("status", { enum: ["new", "learning", "learned"] }).notNull().default("new"),
  repetitions: integer("repetitions").notNull().default(0),
  correctStreak: integer("correct_streak").notNull().default(0),
  correctCount: integer("correct_count").notNull().default(0),
  attemptCount: integer("attempt_count").notNull().default(0),
  easeFactor: integer("ease_factor").notNull().default(250),
  intervalDays: integer("interval_days").notNull().default(0),
  practicedModes: integer("practiced_modes").notNull().default(0),
  nextReviewAt: text("next_review_at").notNull(),
  lastReviewedAt: text("last_reviewed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [uniqueIndex("uq_words_list_term_translation").on(table.listId, table.term, table.translation), index("idx_words_list_due_status").on(table.listId, table.nextReviewAt, table.status)]);

export const learningAttempts = sqliteTable("learning_attempts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  wordId: text("word_id").notNull().references(() => words.id, { onDelete: "cascade" }),
  mode: text("mode", { enum: ["choice", "typing", "sentence", "known"] }).notNull(),
  answer: text("answer"),
  isCorrect: integer("is_correct", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("idx_attempts_user_created").on(table.userId, table.createdAt)]);

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(), count: integer("count").notNull(), windowStartedAt: text("window_started_at").notNull(), expiresAt: text("expires_at").notNull()
});

export const emailOutbox = sqliteTable("email_outbox", {
  id: text("id").primaryKey(), recipient: text("recipient").notNull(), subject: text("subject").notNull(), textBody: text("text_body").notNull(), htmlBody: text("html_body").notNull(), createdAt: text("created_at").notNull()
}, (table) => [index("idx_email_outbox_recipient_created").on(table.recipient, table.createdAt)]);
