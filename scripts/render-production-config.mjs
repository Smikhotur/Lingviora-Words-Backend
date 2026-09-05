import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function value(name, fallback = "") {
  const configured = (process.env[name] ?? "").trim();
  return configured || fallback.trim();
}

function required(name, fallback = "") {
  const result = value(name, fallback);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function httpsOrigin(name, fallback) {
  const configured = required(name, fallback).replace(/\/$/, "");
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} must be a clean HTTPS origin`);
  }
  return url.origin;
}

function hostname(name, fallback) {
  const configured = required(name, fallback).toLowerCase().replace(/\.$/, "");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(configured)) {
    throw new Error(`${name} must be a hostname without a protocol or path`);
  }
  return configured;
}

const databaseId = required("D1_DATABASE_ID");
if (!/^[0-9a-f-]{32,36}$/i.test(databaseId) || /^0+$/.test(databaseId.replaceAll("-", ""))) {
  throw new Error("D1_DATABASE_ID must be the real Cloudflare D1 database id");
}

const turnstileSiteKey = required("TURNSTILE_SITE_KEY");
if (turnstileSiteKey.startsWith("replace-")) throw new Error("TURNSTILE_SITE_KEY is still a placeholder");

const emailFrom = required("EMAIL_FROM");
if (!emailFrom.includes("@")) throw new Error("EMAIL_FROM must contain a verified sender address");

const appBaseUrl = httpsOrigin("APP_BASE_URL", "https://lingviora-words.online");
const allowedOrigins = value(
  "ALLOWED_ORIGINS",
  "https://lingviora-words.online,https://www.lingviora-words.online"
);
for (const origin of allowedOrigins.split(",").map((item) => item.trim()).filter(Boolean)) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:") throw new Error(`Invalid ALLOWED_ORIGINS entry: ${origin}`);
}

const workerDomain = hostname("WORKER_CUSTOM_DOMAIN", "api.lingviora-words.online");
const expectedHostnames = value(
  "TURNSTILE_EXPECTED_HOSTNAMES",
  "lingviora-words.online,www.lingviora-words.online"
);
const emailReplyTo = value("EMAIL_REPLY_TO");

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: value("WORKER_NAME", "lingviora-words-api"),
  main: "src/index.ts",
  compatibility_date: "2026-07-02",
  workers_dev: true,
  preview_urls: false,
  routes: [{ pattern: workerDomain, custom_domain: true }],
  d1_databases: [
    {
      binding: "DB",
      database_name: value("D1_DATABASE_NAME", "lingviora-words-production"),
      database_id: databaseId,
      migrations_dir: "drizzle"
    }
  ],
  vars: {
    APP_ENV: "production",
    APP_BASE_URL: appBaseUrl,
    ALLOWED_ORIGINS: allowedOrigins,
    COOKIE_SAME_SITE: "lax",
    TURNSTILE_SITE_KEY: turnstileSiteKey,
    TURNSTILE_EXPECTED_HOSTNAMES: expectedHostnames,
    EMAIL_FROM: emailFrom,
    ...(emailReplyTo ? { EMAIL_REPLY_TO: emailReplyTo } : {}),
    ALLOW_TEST_MAILBOX: "false"
  }
};

const outputPath = resolve(process.cwd(), "wrangler.production.jsonc");
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Created ${outputPath}`);
