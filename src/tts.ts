import { HttpError } from "./http";

const tokenScope = "https://www.googleapis.com/auth/cloud-platform";
const tokenLifetimeSeconds = 3_300;
const voiceName = "en-US-Neural2-J";
const voiceLanguageCode = "en-US";
const objectPrefix = "tts/v1/en-US-Neural2-J";

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type AccessToken = { value: string; expiresAt: number };

let cachedToken: AccessToken | null = null;
let pendingToken: Promise<AccessToken> | null = null;

function base64Url(bytes: Uint8Array | string) {
  const base64 = typeof bytes === "string" ? btoa(bytes) : btoa(String.fromCharCode(...bytes));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64(value: string) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function readServiceAccount(raw: string | undefined): ServiceAccount {
  if (!raw) throw new HttpError(503, "Озвучення ще налаштовується");
  try {
    const value = JSON.parse(raw) as Partial<ServiceAccount>;
    if (typeof value.client_email !== "string" || typeof value.private_key !== "string") throw new Error("Invalid service account");
    return { client_email: value.client_email, private_key: value.private_key, token_uri: value.token_uri };
  } catch {
    throw new HttpError(503, "Озвучення ще налаштовується");
  }
}

function pemToPkcs8(pem: string) {
  const encoded = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return decodeBase64(encoded).buffer;
}

async function createAssertion(account: ServiceAccount, tokenUri: string) {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: tokenScope,
    aud: tokenUri,
    iat: now,
    exp: now + tokenLifetimeSeconds
  }));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(account.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${base64Url(signature)}`;
}

async function requestAccessToken(account: ServiceAccount): Promise<AccessToken> {
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = await createAssertion(account, tokenUri);
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  if (!response.ok) throw new HttpError(503, "Не вдалося авторизувати озвучення");
  const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== "string") throw new HttpError(503, "Не вдалося авторизувати озвучення");
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : tokenLifetimeSeconds;
  return { value: payload.access_token, expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1_000 };
}

async function getAccessToken(serviceAccountJson: string | undefined) {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  if (!pendingToken) {
    pendingToken = requestAccessToken(readServiceAccount(serviceAccountJson))
      .then((token) => { cachedToken = token; return token; })
      .finally(() => { pendingToken = null; });
  }
  return (await pendingToken).value;
}

function normalizedTerm(term: string) {
  return term.normalize("NFKC").trim().replace(/\s+/g, " ");
}

async function objectKey(term: string) {
  const normalized = normalizedTerm(term);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized.toLocaleLowerCase("en-US")));
  return `${objectPrefix}/${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}.mp3`;
}

async function synthesize(term: string, serviceAccountJson: string | undefined) {
  const accessToken = await getAccessToken(serviceAccountJson);
  const response = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      input: { text: normalizedTerm(term) },
      voice: { languageCode: voiceLanguageCode, name: voiceName },
      audioConfig: { audioEncoding: "MP3", sampleRateHertz: 24_000 }
    })
  });
  if (!response.ok) {
    console.warn("Google TTS synthesis failed", { status: response.status });
    throw new HttpError(503, "Озвучення тимчасово недоступне");
  }
  const payload = await response.json() as { audioContent?: unknown };
  if (typeof payload.audioContent !== "string" || !payload.audioContent) throw new HttpError(503, "Озвучення тимчасово недоступне");
  return decodeBase64(payload.audioContent);
}

export async function getEnglishSpeech(bucket: R2Bucket | undefined, serviceAccountJson: string | undefined, term: string) {
  if (!bucket) throw new HttpError(503, "Сховище озвучення ще налаштовується");
  const key = await objectKey(term);
  const cached = await bucket.get(key);
  if (cached) return cached;
  const audio = await synthesize(term, serviceAccountJson);
  await bucket.put(key, audio, { httpMetadata: { contentType: "audio/mpeg", cacheControl: "private, max-age=31536000, immutable" } });
  const stored = await bucket.get(key);
  if (!stored) throw new HttpError(503, "Не вдалося зберегти озвучення");
  return stored;
}

export function ttsAudioPath(wordId: string) {
  return `/api/words/${encodeURIComponent(wordId)}/audio`;
}
