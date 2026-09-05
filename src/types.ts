export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  APP_ENV?: "development" | "test" | "production";
  APP_BASE_URL?: string;
  ALLOWED_ORIGINS?: string;
  COOKIE_SAME_SITE?: "lax" | "none";
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_EXPECTED_HOSTNAMES?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  MAILER_HTTP_URL?: string;
  MAILER_HTTP_TOKEN?: string;
  ALLOW_TEST_MAILBOX?: string;
}

export type UserSummary = {
  id: string;
  email: string;
  pendingEmail: string | null;
  emailVerifiedAt: string | null;
};

export type LearningMode = "choice" | "typing" | "sentence";

export type LearningCard = {
  wordId: string;
  mode: LearningMode;
  prompt: string;
  instruction: string;
  options?: string[];
  exampleTranslation?: string | null;
  progress: { learned: number; total: number; due: number };
};
