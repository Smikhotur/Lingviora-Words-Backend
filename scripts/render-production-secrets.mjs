import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function secret(name) {
  const result = (process.env[name] ?? "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

const outputPath = resolve(process.cwd(), ".production.secrets.json");
await writeFile(
  outputPath,
  `${JSON.stringify({
    TURNSTILE_SECRET_KEY: secret("TURNSTILE_SECRET_KEY"),
    RESEND_API_KEY: secret("RESEND_API_KEY")
  })}\n`,
  { mode: 0o600 }
);
console.log(`Created ${outputPath} without printing secret values`);

