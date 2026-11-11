# Telegram Public Video Downloader

A Telegram bot that accepts a public video URL and sends the downloaded video back to the same chat.

## Important limits

- Only use this bot for videos you own or are authorized to download and share.
- It does not bypass DRM, paywalls, login requirements, private links, or other access controls.
- It uses yt-dlp, so only websites/formats supported by the installed yt-dlp version may work. No tool can guarantee support for every website.
- Maximum output size is 48 MB to stay below the standard Telegram Bot API upload limit.
- Downloads run in temporary storage and are deleted after processing.
- Do not send private or intimate content shared without the subject's consent.

## Run locally

1. Install Python 3.11 or newer.
2. Install dependencies: `pip install -r requirements.txt`
3. Set the environment variable `BOT_TOKEN` to your Telegram bot token.
4. Run: `python main.py`

## Deploy on Render

Create a **Background Worker** connected to this GitHub repository.

- Runtime: Python
- Build command: `pip install -r requirements.txt`
- Start command: `python main.py`
- Add Environment Variable:
  - Key: `BOT_TOKEN`
  - Value: your token from BotFather

Do not put the bot token in GitHub or commit a `.env` file. After saving the environment variable, deploy the worker and check its logs for `Bot is starting in polling mode.`

## Troubleshooting

- If a website is unsupported, update yt-dlp by redeploying after updating its dependency version.
- If the video is over 48 MB, the bot will reject it rather than attempting an upload that is likely to fail.
- Render's temporary filesystem is used only during a download; the bot does not keep a permanent video library.
