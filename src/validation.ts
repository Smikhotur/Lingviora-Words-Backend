import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().email("Введіть коректну електронну адресу").max(254, "Адреса надто довга");
export const passwordSchema = z.string().min(12, "Пароль має містити щонайменше 12 символів").max(128, "Пароль надто довгий");
const captchaTokenSchema = z.string().min(1, "Підтвердьте, що Ви не робот").max(2048, "Некоректна відповідь капчі");
export const registrationSchema = z.object({ email: emailSchema, password: passwordSchema, captchaToken: captchaTokenSchema });
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1, "Введіть пароль").max(128) });
export const forgotPasswordSchema = z.object({ email: emailSchema, captchaToken: captchaTokenSchema });
export const resetPasswordSchema = z.object({ token: z.string().min(20), password: passwordSchema });
export const tokenSchema = z.object({ token: z.string().min(20) });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });
export const changeEmailSchema = z.object({ currentPassword: z.string().min(1).max(128), newEmail: emailSchema });
export const listSchema = z.object({ name: z.string().trim().min(1, "Назвіть список").max(80), sourceLanguage: z.string().trim().min(2).max(40), targetLanguage: z.string().trim().min(2).max(40) });
export const wordSchema = z.object({ term: z.string().trim().min(1, "Додайте слово").max(160), translation: z.string().trim().min(1, "Додайте переклад").max(240), example: z.string().trim().max(600).optional().nullable(), exampleTranslation: z.string().trim().max(600).optional().nullable(), note: z.string().trim().max(500).optional().nullable() });
export const answerSchema = z.object({ wordId: z.string().uuid(), mode: z.enum(["choice", "typing", "sentence"]), answer: z.string().trim().max(600) });
export const knownSchema = z.object({ wordId: z.string().uuid() });
