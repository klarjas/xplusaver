import asyncio
import ipaddress
import logging
import os
import re
import shutil
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp
from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
MAX_FILE_BYTES = 48 * 1024 * 1024
MAX_DOWNLOAD_SECONDS = 15 * 60
MAX_CONCURRENT_DOWNLOADS = 2
DOWNLOAD_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_DOWNLOADS)

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
)
logger = logging.getLogger("public-video-downloader")
URL_RE = re.compile(r"https?://[^\s<>]+", re.IGNORECASE)


def is_public_http_url(raw_url: str) -> bool:
    """Reject non-HTTP URLs, credentials, localhost, and private/reserved IP targets."""
    try:
        parsed = urlparse(raw_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        if parsed.username or parsed.password:
            return False

        host = parsed.hostname.rstrip(".").lower()
        if host in {"localhost", "localhost.localdomain"} or host.endswith(".localhost"):
            return False

        try:
            ip = ipaddress.ip_address(host)
            return ip.is_global
        except ValueError:
            addresses = socket.getaddrinfo(
                host, parsed.port or (443 if parsed.scheme == "https" else 80)
            )
            return bool(addresses) and all(
                ipaddress.ip_address(item[4][0]).is_global for item in addresses
            )
    except (ValueError, OSError):
        return False


def download_video(url: str, folder: str) -> Path:
    base_options = {
        # Try a ready-made MP4 first; otherwise combine compatible MP4 video
        # and M4A audio streams. FFmpeg is installed by Render via apt.txt.
        "format": "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "max_filesize": MAX_FILE_BYTES,
        "socket_timeout": 25,
        "retries": 3,
        "fragment_retries": 3,
        "file_access_retries": 2,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "overwrites": True,
        "cachedir": False,
        "hls_prefer_native": True,
        "format_sort": ["res:720", "ext:mp4:m4a"],
        # Intentionally no cookies, browser profiles, credentials, or access-control bypass.
    }

    host = (urlparse(url).hostname or "").lower()
    is_x_url = host == "x.com" or host.endswith(".x.com") or host in {
        "twitter.com", "www.twitter.com", "mobile.twitter.com"
    }
    attempts = [("default", {})]
    if is_x_url:
        # X's syndication endpoint can expose public media that the GraphQL
        # endpoint intermittently fails to return. This is a fallback only.
        attempts.append(("x-syndication", {
            "extractor_args": {"twitter": {"api": ["syndication"]}}
        }))

    last_error = None
    for attempt_name, extra_options in attempts:
        attempt_dir = Path(folder) / attempt_name
        attempt_dir.mkdir(parents=True, exist_ok=True)
        options = {
            **base_options,
            **extra_options,
            "outtmpl": str(attempt_dir / "%(title).100s-%(id)s.%(ext)s"),
        }
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                ydl.extract_info(url, download=True)
        except yt_dlp.utils.DownloadError as exc:
            last_error = exc
            logger.warning("Download attempt %s failed: %s", attempt_name, exc)
            continue

        candidates = [
            path for path in attempt_dir.iterdir()
            if path.is_file() and path.suffix.lower() in {
                ".mp4", ".m4v", ".mov", ".webm", ".mkv"
            }
        ]
        if candidates:
            result = max(candidates, key=lambda item: item.stat().st_mtime)
            if result.stat().st_size > MAX_FILE_BYTES:
                raise RuntimeError("វីដេអូធំជាង 48 MB ដែល Bot អាចផ្ញើបាន។")
            return result

    if last_error is not None:
        raise last_error
    raise RuntimeError(
        "មិនរកឃើញឯកសារវីដេអូទេ។ Website នេះអាចមិនមាន Extractor ដែលគាំទ្រ "
        "ឬប្រើ Stream ដែលមិនអាចចូលប្រើដោយសាធារណៈ។"
    )


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.effective_message.reply_text(
        "សួស្តី! ផ្ញើ Link វីដេអូសាធារណៈ ឬវីដេអូដែលអ្នកមានសិទ្ធិទាញយក។\n\n"
        "Bot នឹងពិនិត្យ Link ហើយព្យាយាមផ្ញើវីដេអូត្រឡប់មកវិញ។\n"
        "គាំទ្រ Website/MP4/HLS ដែលអាចទាញយកដោយសាធារណៈ និងមានទំហំអតិបរមា 48 MB។\n"
        "មិនរំលង DRM, paywall, login ឬការការពារសិទ្ធិចូលប្រើទេ។"
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.effective_message.reply_text(
        "របៀបប្រើ៖ ផ្ញើ URL វីដេអូមួយក្នុងសារ។\n"
        "Bot ប្រើ yt-dlp និង FFmpeg ដើម្បីគាំទ្រ MP4 និង Stream មួយចំនួនដូចជា HLS/M3U8។\n"
        "ការគាំទ្រអាស្រ័យលើ Website; មិនអាចធានាថាគ្រប់ Link ដំណើរការទេ។"
    )


async def handle_url(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if not message or not message.text:
        return

    matches = URL_RE.findall(message.text)
    if not matches:
        await message.reply_text("សូមផ្ញើ URL ដែលចាប់ផ្តើមដោយ http:// ឬ https://")
        return

    url = matches[0].rstrip(".,);]")
    if not is_public_http_url(url):
        await message.reply_text("URL មិនត្រឹមត្រូវ ឬមិនអនុញ្ញាតសម្រាប់សុវត្ថិភាពទេ។")
        return

    async with DOWNLOAD_SEMAPHORE:
        status = await message.reply_text("⏳ កំពុងពិនិត្យ Link និងប្រភេទវីដេអូ…")
        workdir = tempfile.mkdtemp(prefix="video-bot-")
        try:
            await context.bot.send_chat_action(
                chat_id=message.chat_id, action=ChatAction.UPLOAD_VIDEO
            )
            try:
                video_path = await asyncio.wait_for(
                    asyncio.to_thread(download_video, url, workdir),
                    timeout=MAX_DOWNLOAD_SECONDS,
                )
            except asyncio.TimeoutError:
                raise RuntimeError("ការទាញយកចំណាយពេលលើស 15 នាទី។ សូមសាកល្បងម្ដងទៀត។")

            await status.edit_text("✅ ទាញយករួចរាល់។ កំពុងផ្ញើវីដេអូ…")
            with video_path.open("rb") as video_file:
                await context.bot.send_video(
                    chat_id=message.chat_id,
                    video=video_file,
                    caption=f"🎬 {video_path.stem[:900]}",
                    supports_streaming=True,
                    read_timeout=180,
                    write_timeout=180,
                    connect_timeout=30,
                )
            await status.delete()
        except yt_dlp.utils.DownloadError as exc:
            error_text = str(exc)
            logger.info("Download failed: %s", error_text)
            if "No video could be found in this tweet" in error_text:
                user_error = (
                    "X/Twitter មាន Post នេះ ប៉ុន្តែ yt-dlp មិនអាចទទួលបានប្រភពវីដេអូទេ។ "
                    "អាចបណ្តាលមកពី X តម្រូវឱ្យ Login ឬមិនបង្ហាញ Media ទៅកាន់ការទាញយកសាធារណៈ។ "
                    "សូមពិនិត្យថា Post អាចមើលបានជាសាធារណៈ និងសាកល្បងម្ដងទៀតក្រោយ Update។"
                )
            else:
                user_error = (
                    "មិនអាចទាញយក Link នេះបានទេ។ Website អាចមិនគាំទ្រ, Link អាចផុតកំណត់ "
                    "ឬវីដេអូមិនអាចចូលប្រើជាសាធារណៈ។ Bot មិនប្រើ Cookies/Login ដើម្បីរំលងការការពារទេ។"
                )
            await status.edit_text(user_error)
        except Exception as exc:
            logger.exception("Video processing failed")
            safe_message = str(exc)
            if len(safe_message) > 250:
                safe_message = safe_message[:250] + "…"
            await status.edit_text(f"មិនអាចដំណើរការបានទេ៖ {safe_message}")
        finally:
            shutil.rmtree(workdir, ignore_errors=True)


async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.exception("Unhandled Telegram update error", exc_info=context.error)


class HealthHandler(BaseHTTPRequestHandler):
    """Tiny HTTP health endpoint so this polling bot can run on Render Web Service."""

    def do_GET(self) -> None:
        if self.path not in {"/", "/health", "/healthz"}:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")
            return

        body = b"OK - Telegram video downloader is running"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        # Keep routine health checks out of the application logs.
        return


def start_health_server() -> None:
    port = int(os.getenv("PORT", "10000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    thread = threading.Thread(target=server.serve_forever, name="render-health", daemon=True)
    thread.start()
    logger.info("Health server listening on 0.0.0.0:%s", port)


def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN is missing. Add it in Render Environment Variables.")

    # Render currently hosts this as a Web Service, so expose a health port
    # while the Telegram bot continues to receive updates through polling.
    start_health_server()

    application = Application.builder().token(BOT_TOKEN).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_url))
    application.add_error_handler(error_handler)

    logger.info("Bot is starting in polling mode.")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
