import { requireUser } from "../auth";
import { assertTrustedOrigin, firstValidationError, HttpError, json, parseJson } from "../http";
import { getList, getLists, ownedWord, ownsList } from "../repository";
import type { Env } from "../types";
import { listSchema, wordSchema } from "../validation";

function optional(value?: string | null) {
  return value?.trim() || null;
}

export async function listIndex(request: Request, env: Env) {
  const user = await requireUser(env.DB, request);
  if (request.method === "GET") return json({ lists: await getLists(env.DB, user.id) });
  assertTrustedOrigin(request, env);
  const parsed = listSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO word_lists (id, user_id, name, source_language, target_language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, user.id, parsed.data.name, parsed.data.sourceLanguage, parsed.data.targetLanguage, now, now).run();
  return json({ id }, 201);
}

export async function listItem(request: Request, env: Env, id: string) {
  const user = await requireUser(env.DB, request);
  if (request.method === "GET") return json({ list: await getList(env.DB, user.id, id) });
  assertTrustedOrigin(request, env);
  if (request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM word_lists WHERE id = ? AND user_id = ?").bind(id, user.id).run();
    if (!result.meta.changes) throw new HttpError(404, "Список не знайдено");
    return json({ ok: true });
  }
  if (!(await ownsList(env.DB, user.id, id))) throw new HttpError(404, "Список не знайдено");
  const parsed = listSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  await env.DB.prepare(`UPDATE word_lists SET name = ?, source_language = ?, target_language = ?, updated_at = ? WHERE id = ? AND user_id = ?`).bind(parsed.data.name, parsed.data.sourceLanguage, parsed.data.targetLanguage, new Date().toISOString(), id, user.id).run();
  return json({ ok: true });
}

export async function createWord(request: Request, env: Env, listId: string) {
  assertTrustedOrigin(request, env);
  const user = await requireUser(env.DB, request);
  if (!(await ownsList(env.DB, user.id, listId))) throw new HttpError(404, "Список не знайдено");
  const parsed = wordSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`INSERT INTO words (id, list_id, term, translation, example, example_translation, note, status, repetitions, correct_streak, correct_count, attempt_count, ease_factor, interval_days, practiced_modes, next_review_at, last_reviewed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', 0, 0, 0, 0, 250, 0, 0, ?, NULL, ?, ?)`).bind(id, listId, parsed.data.term, parsed.data.translation, optional(parsed.data.example), optional(parsed.data.exampleTranslation), optional(parsed.data.note), now, now, now).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "Таке слово з цим перекладом уже є у списку");
    throw error;
  }
  await env.DB.prepare("UPDATE word_lists SET updated_at = ? WHERE id = ?").bind(now, listId).run();
  return json({ id }, 201);
}

export async function wordItem(request: Request, env: Env, id: string) {
  assertTrustedOrigin(request, env);
  const user = await requireUser(env.DB, request);
  const word = await ownedWord(env.DB, user.id, id);
  if (!word) throw new HttpError(404, "Слово не знайдено");
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM words WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  const parsed = wordSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  try {
    await env.DB.prepare(`UPDATE words SET term = ?, translation = ?, example = ?, example_translation = ?, note = ?, updated_at = ? WHERE id = ?`).bind(parsed.data.term, parsed.data.translation, optional(parsed.data.example), optional(parsed.data.exampleTranslation), optional(parsed.data.note), new Date().toISOString(), id).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "Таке слово з цим перекладом уже є у списку");
    throw error;
  }
  return json({ ok: true });
}
