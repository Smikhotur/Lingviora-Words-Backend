import assert from "node:assert/strict";
import test from "node:test";
import { assertEmailDeliveryConfigured, sendEmail } from "../src/email";
import type { Env } from "../src/types";

test("requires Resend credentials in production", () => {
  assert.throws(() => assertEmailDeliveryConfigured({ APP_ENV: "production" } as Env), /RESEND_API_KEY/);
});

test("sends production email through Resend without exposing credentials in the body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer re_test_secret");
    assert.match(headers.get("idempotency-key") ?? "", /^lingviora-[a-f0-9]{64}$/);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.deepEqual(body, {
      from: "Lingviora Words <no-reply@account.example.com>",
      to: ["user@example.com"],
      subject: "Підтвердження",
      text: "Text",
      html: "<p>Text</p>",
      reply_to: "support@example.com"
    });
    assert.equal(JSON.stringify(body).includes("re_test_secret"), false);
    return new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
  };

  try {
    await sendEmail({} as D1Database, {
      APP_ENV: "production",
      RESEND_API_KEY: "re_test_secret",
      EMAIL_FROM: "Lingviora Words <no-reply@account.example.com>",
      EMAIL_REPLY_TO: "support@example.com"
    } as Env, { to: "user@example.com", subject: "Підтвердження", text: "Text", html: "<p>Text</p>" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
