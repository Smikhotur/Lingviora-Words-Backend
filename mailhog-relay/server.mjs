import { createServer } from "node:http";
import { connect } from "node:net";

const port = Number(process.env.PORT ?? 8026);
const smtpHost = process.env.SMTP_HOST ?? "127.0.0.1";
const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
const token = process.env.MAILER_HTTP_TOKEN ?? "";
const safeHeader = (value) => String(value).replace(/[\r\n]+/g, " ").trim();

function waitForReply(socket, expectedCode) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => { socket.off("data", onData); socket.off("error", onError); };
    const onError = (error) => { cleanup(); reject(error); };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n").filter(Boolean);
      const final = lines.find((line) => line.startsWith(`${expectedCode} `));
      if (final) { cleanup(); resolve(final); }
      else if (lines.some((line) => /^\d{3} /.test(line))) { cleanup(); reject(new Error(`Unexpected SMTP response: ${lines.at(-1)}`)); }
    };
    socket.on("data", onData); socket.on("error", onError);
  });
}

async function command(socket, value, code) { socket.write(`${value}\r\n`); await waitForReply(socket, code); }
const encodeBody = (value) => Buffer.from(String(value), "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";

async function sendToMailHog(message) {
  const socket = connect({ host: smtpHost, port: smtpPort });
  await waitForReply(socket, 220); await command(socket, "EHLO lingviora.local", 250); await command(socket, "MAIL FROM:<no-reply@lingviora.local>", 250); await command(socket, `RCPT TO:<${safeHeader(message.to)}>`, 250); await command(socket, "DATA", 354);
  const boundary = `lingviora-${crypto.randomUUID()}`;
  const mail = ["From: Lingviora Words <no-reply@lingviora.local>", `To: ${safeHeader(message.to)}`, `Subject: =?UTF-8?B?${Buffer.from(safeHeader(message.subject), "utf8").toString("base64")}?=`, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "", `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", encodeBody(message.text), `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", encodeBody(message.html), `--${boundary}--`, ".", ""].join("\r\n");
  socket.write(mail); await waitForReply(socket, 250); socket.write("QUIT\r\n"); socket.end();
}

createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/send") { response.writeHead(404).end(); return; }
  if (token && request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
  let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; if (body.length > 1_000_000) request.destroy(); });
  request.on("end", async () => { try { const message = JSON.parse(body); if (!message.to || !message.subject || !message.text || !message.html) { response.writeHead(400, { "content-type": "application/json" }).end('{"error":"Invalid message"}'); return; } await sendToMailHog(message); response.writeHead(204).end(); } catch (error) { console.error(error); response.writeHead(502, { "content-type": "application/json" }).end('{"error":"Mail delivery failed"}'); } });
}).listen(port, "0.0.0.0", () => console.log(`MailHog relay listening on ${port}`));
