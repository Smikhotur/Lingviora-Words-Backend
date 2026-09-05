import assert from "node:assert/strict";
import test from "node:test";
import { turnstileResultIsValid } from "../src/turnstile";

test("accepts a Turnstile result only for the expected action and hostname", () => {
  assert.equal(turnstileResultIsValid({ success: true, action: "register", hostname: "words.example.com" }, "register", ["words.example.com"]), true);
  assert.equal(turnstileResultIsValid({ success: true, action: "forgot_password", hostname: "words.example.com" }, "register", ["words.example.com"]), false);
  assert.equal(turnstileResultIsValid({ success: true, action: "register", hostname: "attacker.example" }, "register", ["words.example.com"]), false);
  assert.equal(turnstileResultIsValid({ success: false, action: "register", hostname: "words.example.com" }, "register", ["words.example.com"]), false);
});
