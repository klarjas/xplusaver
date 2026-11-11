# XPlusAver — Telegram Video Downloader

Telegram bot that accepts a video URL and sends back a downloadable video when the source makes the media publicly accessible and the user is authorized to download/share it.

## Features

- Telegram `/start` and `/help` commands.
- Direct MP4/media URL detection.
- yt-dlp extraction for supported public video pages.
- Playwright Chromium network-media detection as a fallback.
- FFmpeg processing for supported, unencrypted HLS/DASH streams and file compression.
- Temporary download cleanup after each request.
- SSRF-oriented checks that reject localhost and private/reserved IP destinations.
- 48 MB output target for Telegram Bot API compatibility; 1 GB temporary input ceiling.
- 15-minute download timeout and bounded concurrent downloads.
- Render `/health` endpoint.

## Important limitations

- Use only videos you own or are authorized to download and share.
- The bot does not bypass DRM, encryption keys, paywalls, login walls, CAPTCHA, private sessions, or other access controls.
- It does not collect browser cookies, passwords, or private session tokens.
- Some websites may block server-side access or require a supported extractor; a link that plays in a personal browser may still fail on a server.
- Direct links can expire or require a valid Referer/session. HTTP 403 means the source refused the request; it is not proof that every other authorized access method will fail.
- Telegram upload limits and source-site terms apply.

## Run locally (Windows / Linux)

1. Install Python 3.12 and FFmpeg.
2. Create a Telegram bot with BotFather and copy its token.
3. Install dependencies:

   ```bash
   pip install -r requirements.txt
   python -m playwright install chromium
   ```

4. Set `BOT_TOKEN` as an environment variable (do not put the real token in GitHub).
5. Run:

   ```bash
   python main.py
   ```

## Deploy to Render

1. Connect this GitHub repository to Render as a **Web Service**.
2. Render can use the included `render.yaml` Blueprint settings.
3. Add `BOT_TOKEN` under Render → Environment. Keep it secret; never commit it.
4. Build command:

   ```bash
   pip install --upgrade pip && pip install -r requirements.txt && python -m playwright install chromium
   ```

5. Start command: `python main.py`.
6. Confirm the service health endpoint responds at `/health`.

The service uses Telegram long polling and a small HTTP health endpoint. Do not run a second copy of the same bot token at the same time, because Telegram polling conflicts when multiple instances consume the same updates.

## Configuration

| Variable | Required | Description |
|---|---:|---|
| `BOT_TOKEN` | Yes | Telegram BotFather token |
| `PORT` | No | HTTP health port; defaults to `10000` |
| `LOG_LEVEL` | No | Logging level; defaults to `INFO` |

## Repository safety

- `.env` and local secrets are ignored by `.gitignore`.
- Do not upload bot tokens, cookies, passwords, or private video links to this repository.
- Temporary media is deleted after the bot finishes processing.
