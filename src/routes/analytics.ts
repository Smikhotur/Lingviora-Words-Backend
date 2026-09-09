import { canViewAnalytics, getAnalytics, parseAnalyticsPagination } from "../analytics";
import { requireUser } from "../auth";
import { HttpError, json } from "../http";
import type { Env } from "../types";

export async function analytics(request: Request, env: Env) {
  const user = await requireUser(env.DB, request);
  if (!canViewAnalytics(user)) throw new HttpError(403, "Доступ до аналітики заборонено");
  const { page, pageSize } = parseAnalyticsPagination(new URL(request.url));
  return json(await getAnalytics(env.DB, page, pageSize));
}
