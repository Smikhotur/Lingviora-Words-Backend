import { requireUser } from "../auth";
import { assertTrustedOrigin, firstValidationError, HttpError, json, parseJson } from "../http";
import { getNextLearningCard, markWordKnown, recordAnswer } from "../learning";
import type { Env } from "../types";
import { answerSchema, knownSchema } from "../validation";

export async function session(request: Request, env: Env) {
  const user = await requireUser(env.DB, request);
  const listId = new URL(request.url).searchParams.get("listId");
  if (!listId) throw new HttpError(400, "Не вказано список");
  return json({ card: await getNextLearningCard(env.DB, user.id, listId) });
}

export async function answer(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  const user = await requireUser(env.DB, request);
  const parsed = answerSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  return json(await recordAnswer(env.DB, user.id, parsed.data.wordId, parsed.data.mode, parsed.data.answer));
}

export async function known(request: Request, env: Env) {
  assertTrustedOrigin(request, env);
  const user = await requireUser(env.DB, request);
  const parsed = knownSchema.safeParse(await parseJson(request));
  if (!parsed.success) throw new HttpError(400, firstValidationError(parsed.error));
  await markWordKnown(env.DB, user.id, parsed.data.wordId);
  return json({ ok: true });
}
