import { requireUser } from "../auth";
import { HttpError } from "../http";
import { isEnglishLanguage } from "../languages";
import { ownedWord } from "../repository";
import { getEnglishSpeech } from "../tts";
import type { Env } from "../types";

export async function wordAudio(request: Request, env: Env, wordId: string) {
  const user = await requireUser(env.DB, request);
  const word = await ownedWord(env.DB, user.id, wordId);
  if (!word || !isEnglishLanguage(word.sourceLanguage)) throw new HttpError(404, "Озвучення не знайдено");
  const object = await getEnglishSpeech(env.AUDIO, env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON, word.term);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", headers.get("content-type") ?? "audio/mpeg");
  headers.set("cache-control", "private, max-age=31536000, immutable");
  headers.set("accept-ranges", "bytes");
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}
