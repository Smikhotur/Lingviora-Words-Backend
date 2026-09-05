const encoder = new TextEncoder();
const PASSWORD_ITERATIONS = 310_000;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function derivePassword(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(salt), iterations: PASSWORD_ITERATIONS }, key, 256);
  return new Uint8Array(bits);
}

export async function createPasswordHash(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: bytesToBase64(await derivePassword(password, salt)), salt: bytesToBase64(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string) {
  try {
    return constantTimeEqual(await derivePassword(password, base64ToBytes(salt)), base64ToBytes(hash));
  } catch {
    return false;
  }
}

export function randomToken(size = 32) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(size))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hashToken(value: string) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function anonymousFingerprint(request: Request, scope: string) {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const agent = request.headers.get("user-agent")?.slice(0, 160) ?? "unknown";
  return hashToken(`${scope}:${ip}:${agent}`);
}
