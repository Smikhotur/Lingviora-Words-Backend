import type { Env } from "./types";

type EmailMessage = { to: string; subject: string; text: string; html: string };

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export function assertEmailDeliveryConfigured(env: Env) {
  if (env.APP_ENV === "production" && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) {
    throw new Error("RESEND_API_KEY and EMAIL_FROM are required in production");
  }
}

async function emailIdempotencyKey(message: EmailMessage) {
  const input = new TextEncoder().encode(`${message.to}\n${message.subject}\n${message.text}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `lingviora-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function sendWithResend(env: Env, message: EmailMessage) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error("Resend email delivery is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": await emailIdempotencyKey(message)
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(env.EMAIL_REPLY_TO ? { reply_to: env.EMAIL_REPLY_TO } : {})
      }),
      signal: controller.signal
    });
  } catch {
    throw new Error("Resend request failed");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    console.error("Resend rejected an email", { status: response.status, requestId: response.headers.get("x-request-id") });
    throw new Error(`Resend rejected the email with status ${response.status}`);
  }
}

export async function sendEmail(db: D1Database, env: Env, message: EmailMessage) {
  assertEmailDeliveryConfigured(env);
  if (env.RESEND_API_KEY || env.EMAIL_FROM || env.APP_ENV === "production") {
    await sendWithResend(env, message);
    return;
  }
  if (env.MAILER_HTTP_URL) {
    const url = new URL(env.MAILER_HTTP_URL);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (!local) throw new Error("The MailHog relay is available only for local development");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.MAILER_HTTP_TOKEN ? { authorization: `Bearer ${env.MAILER_HTTP_TOKEN}` } : {}) },
      body: JSON.stringify(message)
    });
    if (!response.ok) throw new Error(`Mail relay failed with ${response.status}`);
    return;
  }
  if (env.ALLOW_TEST_MAILBOX === "true") {
    await db.prepare(`INSERT INTO email_outbox (id, recipient, subject, text_body, html_body, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), message.to, message.subject, message.text, message.html, new Date().toISOString()).run();
    return;
  }
  throw new Error("Email delivery is not configured");
}

function safeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function verificationEmail(link: string, change = false) {
  const title = change ? "Підтвердіть нову електронну адресу" : "Підтвердіть електронну адресу";
  const intro = change ? "Щоб завершити зміну адреси у Lingviora Words, перейдіть за посиланням:" : "Щоб активувати обліковий запис Lingviora Words, перейдіть за посиланням:";
  return { subject: title, text: `${intro}\n\n${link}\n\nПосилання діє 24 години.`, html: `<h1>${title}</h1><p>${intro}</p><p><a href="${safeHtml(link)}">Підтвердити адресу</a></p><p>Посилання діє 24 години.</p>` };
}

export function resetEmail(link: string) {
  return { subject: "Відновлення пароля", text: `Щоб створити новий пароль Lingviora Words, перейдіть за посиланням:\n\n${link}\n\nПосилання діє 30 хвилин.`, html: `<h1>Відновлення пароля</h1><p>Щоб створити новий пароль Lingviora Words, перейдіть за посиланням:</p><p><a href="${safeHtml(link)}">Створити новий пароль</a></p><p>Посилання діє 30 хвилин.</p>` };
}
