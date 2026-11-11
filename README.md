# Telegram Public Video Downloader

A Telegram bot that accepts a public video URL and sends the downloaded video back to the same chat.

## Features

- Detects supported public video pages and direct media URLs using yt-dlp.
- Supports MP4 and some HLS/M3U8 streams when the source permits public downloading.
- Uses FFmpeg to merge compatible video/audio streams into MP4.
- Deletes temporary downloads after sending.
- Limits downloads to 48 MB and 15 minutes.

## Important limits

- Only use this bot for videos you own or are authorized to download and share.
- It does not bypass DRM, paywalls, login requirements, private links, or other access controls.
- Support depends on the website and its current player/stream implementation. IDM working in a logged-in browser does not guarantee that a server-side bot can access the same stream.
- No browser cookies, login credentials, or private session tokens are collected.
- Telegram Bot API upload limits apply; this project caps output at 48 MB.
- Do not send private or intimate content shared without the subject's consent.

## Run locally

1. Install Python 3.11 or newer and FFmpeg.
2. Install dependencies: `pip install -r requirements.txt`
3. Set environment variable `BOT_TOKEN` to your Telegram bot token.
4. Run: `python main.py`

## Deploy on Render

Create a **Background Worker** connected to this GitHub repository.

- Runtime: Python
- Build command: `pip install -r requirements.txt`
- Start command: `python main.py`
- Environment Variable:
  - Key: `BOT_TOKEN`
  - Value: your token from BotFather

The `apt.txt` file requests FFmpeg for stream merging. Do not put the bot token in GitHub or commit a `.env` file. After saving the environment variable, deploy the worker and check logs for `Bot is starting in polling mode.`

## Troubleshooting

- Unsupported page: the website may not be supported by yt-dlp or may require a browser-only session.
- HLS/M3U8: only publicly accessible streams can be processed; some streams require authorization or DRM and will not work.
- File too large: videos over 48 MB are rejected to avoid failed Telegram uploads.
- Render temporary storage is used only during processing; no permanent video library is kept.
