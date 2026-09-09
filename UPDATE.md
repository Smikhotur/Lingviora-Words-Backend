# Google Cloud TTS + R2 update

## What changed

- English-word playback now uses Google Cloud Text-to-Speech voice `en-US-Neural2-J`.
- Audio is generated only on the first play of each distinct word, then cached in the private R2 bucket `lingviora-words-audio`.
- The browser obtains audio only through an authenticated API route. Each user can hear only words from their own lists.
- Existing English words automatically use the new voice after deployment. No database migration is needed.
- IPA transcription continues to come from the current dictionary/Datamuse logic.

## Before deploy

You have already completed these steps:

- enabled Cloud Text-to-Speech API in Google Cloud project `sonic-choir-373016`;
- uploaded `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` to the production Worker;
- created the private R2 bucket `lingviora-words-audio`.

Do not add the Google JSON key to Git or frontend environment variables.

## Deploy order

### 1. Backend

Copy the contents of this archive into `Lingviora-Words-Backend`, then run:

```bash
npm ci && npm run check && npm run deploy:production
```

There are no new D1 migrations.

### 2. Check the Worker binding

The deploy output must list:

```text
env.AUDIO (lingviora-words-audio) R2 Bucket
```

### 3. Frontend

Copy the frontend archive into `Lingviora-Words-Frontend`. On `develop` run:

```bash
npm ci && npm run typecheck && VITE_API_URL=https://api.lingviora-words.online npm run build:production
```

Commit, push `develop`, open a PR to `main`, and merge after checks pass.

## Verify after deployment

1. Sign in to the site.
2. Open any English list.
3. Press the speaker icon for a word.
4. Refresh the R2 bucket page: after the first successful play, it will contain an MP3 object.
5. Play the same word again: it should use the stored R2 object without another Google TTS request.
