# Lingviora Backend

Окремий Cloudflare Worker API з D1, HTTP-only сесіями, Cloudflare Turnstile, підтвердженням пошти через Resend, лімітами запитів і адаптивним плануванням повторень.

## Локальний запуск

```bash
cp .dev.vars.example .dev.vars
npm ci
docker compose -f docker-compose.mailhog.yml up -d
npm run db:local
npm run dev
```

MailHog: `http://localhost:8025`. Локальний relay приймає листи Worker на `http://127.0.0.1:8026/send` і передає їх у MailHog.

## Production

### 1. Підготуйте конфігурацію

```bash
cp wrangler.production.example.jsonc wrangler.production.jsonc
cp .env.production.example .env.production
```

У `wrangler.production.jsonc` замініть усі `example.com`, Turnstile site key та D1 `database_id`:

- `APP_BASE_URL` — HTTPS-адреса фронтенду, на яку ведуть посилання з листів;
- `ALLOWED_ORIGINS` — точний origin фронтенду без `/` у кінці;
- `TURNSTILE_EXPECTED_HOSTNAMES` — дозволені хости фронтенду через кому, без `https://`;
- `EMAIL_FROM` — адреса на верифікованому домені Resend;
- `EMAIL_REPLY_TO` — реальна адреса підтримки.

Якщо frontend та API розміщені на різних сайтах, встановіть `COOKIE_SAME_SITE` у `none`. Для піддоменів одного HTTPS-домену (`words.example.com` і `api.example.com`) залиште `lax`.

### 2. Створіть реальну капчу

У Cloudflare Dashboard створіть Turnstile widget у режимі **Managed** і додайте всі production-хости фронтенду. Site key запишіть у `wrangler.production.jsonc`, а secret key — лише у `.env.production` як `TURNSTILE_SECRET_KEY`.

Backend обов'язково перевіряє токен через Siteverify, його `action` та hostname. Для реєстрації використовується action `register`, для відновлення пароля — `forgot_password`.

### 3. Налаштуйте реальну пошту

У Resend додайте та підтвердьте окремий піддомен для транзакційних листів, наприклад `account.example.com`. Після DNS-верифікації створіть API key та запишіть його у `.env.production` як `RESEND_API_KEY`.

Secret-файл має містити тільки:

```dotenv
TURNSTILE_SECRET_KEY="..."
RESEND_API_KEY="re_..."
```

Не додавайте `.env.production`, `.dev.vars` або ключі до Git.

### 4. Створіть D1 і розгорніть Worker

```bash
npx wrangler d1 create lingviora-words-production
```

Скопіюйте отриманий UUID у `wrangler.production.jsonc`, після чого:

```bash
npm run typecheck
npm test
npm run db:production
npm run deploy:production -- --secrets-file .env.production
```

Для наступної ротації окремого секрету використовуйте:

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.production.jsonc
npx wrangler secret put RESEND_API_KEY --config wrangler.production.jsonc
```

## Що вже захищено

- тестова поштова скринька примусово вимкнена при `APP_ENV=production`;
- secret key Turnstile і Resend API key не зберігаються у конфігурації або frontend;
- verification/reset токени одноразові, зберігаються у D1 лише у вигляді хешів і мають термін дії;
- зміна пошти завершується лише після підтвердження нової адреси;
- forgot-password не повідомляє, чи існує користувач;
- production-посилання у листах дозволені лише через HTTPS.
