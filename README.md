# Lingviora Words Backend

Cloudflare Worker API з D1, HTTP-only сесіями, Cloudflare Turnstile та відправкою листів через Resend.

## Гілки та середовища

| Подія | Результат |
| --- | --- |
| Робота в `develop` + `npm run dev` | Локальний Worker на `http://127.0.0.1:8787`, локальна D1 і MailHog |
| Push у `develop` або PR | GitHub Actions запускає typecheck і тести без деплою |
| Push/merge у `prod` | GitHub Actions застосовує D1-міграції та автоматично публікує production Worker |

Production API: `https://api.lingviora-words.online`  
Production frontend: `https://lingviora-words.online`

## Локальний запуск

```bash
nvm use
cp .dev.vars.example .dev.vars
npm ci
docker compose -f docker-compose.mailhog.yml up -d
npm run db:local
npm run dev
```

Frontend запускайте окремо на `http://localhost:5173`. Його Vite proxy автоматично направляє `/api` на локальний Worker. MailHog доступний на `http://localhost:8025`.

`.dev.vars` містить лише локальні ключі та не потрапляє до Git.

## Одноразове production-налаштування

### 1. Додайте домен до Cloudflare

Worker custom domain потребує, щоб DNS-зона `lingviora-words.online` керувалася Cloudflare.

1. Додайте домен до Cloudflare.
2. У Cloudflare DNS створіть `A` для `@` → `46.62.131.70` і `CNAME` для `www` → `lingviora-words.online`.
3. Не створюйте `A`-запис для `api`: його створить Wrangler як Worker custom domain.
4. У реєстратора замініть nameservers на ті, які видасть Cloudflare, і дочекайтеся статусу **Active**.

### 2. Створіть production D1

```bash
npm ci
npx wrangler login
npx wrangler d1 create lingviora-words-production
```

Збережіть отриманий `database_id`: він потрібен як GitHub variable `D1_DATABASE_ID`.

### 3. Налаштуйте Turnstile і Resend

- Створіть Cloudflare Turnstile widget у режимі **Managed** для `lingviora-words.online` і `www.lingviora-words.online`.
- У Resend підтвердьте поштовий домен, наприклад `mail.lingviora-words.online`, і створіть API key.
- Адреса у `EMAIL_FROM` мусить належати підтвердженому в Resend домену.

### 4. Створіть GitHub Environment

У backend-репозиторії відкрийте **Settings → Environments → New environment** і створіть `production`.

Додайте до нього variables:

| Variable | Значення |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | ID Cloudflare-акаунта |
| `D1_DATABASE_ID` | ID створеної production D1 |
| `D1_DATABASE_NAME` | `lingviora-words-production` |
| `TURNSTILE_SITE_KEY` | Публічний production site key |
| `EMAIL_FROM` | `Lingviora Words <no-reply@mail.lingviora-words.online>` |
| `EMAIL_REPLY_TO` | Реальна адреса підтримки |
| `WORKER_CUSTOM_DOMAIN` | `api.lingviora-words.online` |

Додайте secrets:

| Secret | Значення |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Токен з правами на Workers, D1 і Worker routes цієї зони |
| `TURNSTILE_SECRET_KEY` | Секрет production Turnstile widget |
| `RESEND_API_KEY` | Production API key Resend |

Workflow не записує секрети у репозиторій. `wrangler.production.jsonc` генерується в GitHub runner із variables і теж ігнорується Git.

## Production-деплой

Рекомендований шлях — Pull Request з `develop` у `prod`. Після merge файл `.github/workflows/deploy-production.yml` автоматично:

1. встановить залежності;
2. запустить typecheck і тести;
3. створить production Wrangler config;
4. застосує нові D1 migrations;
5. оновить секрети Worker;
6. розгорне API та перевірить `/api/health`.

Ручний запуск того самого workflow доступний у вкладці **Actions** через `workflow_dispatch`.

## Локальна production-перевірка без збереження секретів у Git

```bash
cp .env.production.example .env.production
D1_DATABASE_ID="your-d1-id" \
TURNSTILE_SITE_KEY="your-site-key" \
EMAIL_FROM="Lingviora Words <no-reply@mail.lingviora-words.online>" \
npm run config:production

npm run check
npm run db:production
npm run deploy:production -- --secrets-file .env.production
```

Не додавайте `.env.production`, `.dev.vars` або `wrangler.production.jsonc` до Git.

