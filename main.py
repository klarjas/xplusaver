import asyncio
import ipaddress
import logging
import os
import re
import shutil
import subprocess
import socket
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

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




def _validate_manifest(manifest_url: str, page_referer: str, user_agent: str) -> None:
    """Allow only public, unencrypted HLS/DASH manifests before handing them to FFmpeg."""
    request = urllib.request.Request(
        manifest_url,
        headers={"User-Agent": user_agent, "Referer": page_referer, "Accept": "*/*"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        final_url = response.geturl()
        if not is_public_http_url(final_url):
            raise RuntimeError("Manifest redirect មិនមានសុវត្ថិភាពទេ។")
        content = response.read(5 * 1024 * 1024 + 1)
    if len(content) > 5 * 1024 * 1024:
        raise RuntimeError("Manifest ធំពេកសម្រាប់ការត្រួតពិនិត្យ។")
    text = content.decode("utf-8", errors="replace")
    lower = text.lower()

    if "#extm3u" in lower:
        # Do not fetch encrypted HLS keys or DRM-protected streams.
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.upper().startswith("#EXT-X-KEY:") and "METHOD=NONE" not in stripped.upper():
                raise RuntimeError("HLS នេះប្រើ Encryption/Key; Bot មិនរំលងការការពារនេះទេ។")
            if stripped and not stripped.startswith("#"):
                candidate = urllib.parse.urljoin(final_url, stripped)
                if not is_public_http_url(candidate):
                    raise RuntimeError("HLS មាន Segment URL មិនមានសុវត្ថិភាព។")
        for match in re.findall(r'URI="([^"]+)"', text, flags=re.IGNORECASE):
            candidate = urllib.parse.urljoin(final_url, match)
            if not is_public_http_url(candidate):
                raise RuntimeError("HLS មាន URI មិនមានសុវត្ថិភាព។")
        return

    if "<mpd" in lower:
        if "contentprotection" in lower:
            raise RuntimeError("DASH នេះមាន ContentProtection/DRM; មិនអាចទាញយកបានទេ។")
        try:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(text)
            for element in root.iter():
                if element.tag.rsplit("}", 1)[-1].lower() == "baseurl" and element.text:
                    candidate = urllib.parse.urljoin(final_url, element.text.strip())
                    if not is_public_http_url(candidate):
                        raise RuntimeError("DASH មាន BaseURL មិនមានសុវត្ថិភាព។")
        except ET.ParseError as exc:
            raise RuntimeError("DASH Manifest មិនត្រឹមត្រូវ។") from exc
        return

    raise RuntimeError("Response ដែលចាប់បានមិនមែនជា HLS ឬ DASH Manifest ទេ.")


def _compress_for_telegram(source: Path, folder: str) -> Path:
    if source.stat().st_size <= MAX_FILE_BYTES:
        return source
    compressed = Path(folder) / "compressed-for-telegram.mp4"
    for crf in ("27", "31", "34"):
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(source), "-vf", "scale='min(1280,iw)':-2",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", crf,
                "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
                "-fs", str(MAX_FILE_BYTES), str(compressed),
            ],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=MAX_DOWNLOAD_SECONDS,
        )
        if compressed.exists() and compressed.stat().st_size <= MAX_FILE_BYTES:
            return compressed
    raise RuntimeError("វីដេអូធំពេក ហើយមិនអាចបង្ហាប់ឱ្យតូចជាង 48 MB បានទេ។")


def download_public_manifest(manifest_url: str, page_url: str, folder: str) -> Path:
    """Download public, unencrypted HLS/DASH with FFmpeg; no cookies or auth bypass."""
    user_agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    parsed = urlparse(page_url)
    referer = f"{parsed.scheme}://{parsed.netloc}/"
    if not is_public_http_url(manifest_url):
        raise RuntimeError("Manifest URL មិនអនុញ្ញាតសម្រាប់សុវត្ថិភាពទេ។")
    _validate_manifest(manifest_url, referer, user_agent)

    target = Path(folder) / "stream-download.mp4"
    headers = f"User-Agent: {user_agent}\r\nReferer: {referer}\r\n"
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-headers", headers,
                "-protocol_whitelist", "http,https,tcp,tls,crypto,data",
                "-i", manifest_url, "-map", "0:v:0?", "-map", "0:a:0?",
                "-c", "copy", "-movflags", "+faststart",
                "-fs", str(1024 * 1024 * 1024), str(target),
            ],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            timeout=MAX_DOWNLOAD_SECONDS,
        )
    except subprocess.CalledProcessError as exc:
        details = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else str(exc)
        raise RuntimeError("FFmpeg HLS/DASH error: " + details[-1200:]) from exc
    if not target.exists() or target.stat().st_size == 0:
        raise RuntimeError("FFmpeg មិនបានបង្កើតឯកសារវីដេអូទេ។")
    return _compress_for_telegram(target, folder)


def resolve_browser_media(page_url: str, folder: str) -> Path:
    """IDM-style fallback: inspect public browser responses for MP4 and HLS/DASH manifests."""
    captured = []
    captured_manifests = []
    with sync_playwright() as p:
        launch_args = [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-zygote",
        ]
        try:
            browser = p.chromium.launch(
                headless=True, args=launch_args, timeout=60000
            )
        except Exception as launch_error:
            error_text = str(launch_error).lower()
            if "executable doesn't exist" in error_text:
                logger.warning("Playwright Chromium binary unavailable; installing Chromium.")
                subprocess.run(
                    [sys.executable, "-m", "playwright", "install", "chromium"],
                    check=True, timeout=240,
                )
                browser = p.chromium.launch(
                    headless=True, args=launch_args, timeout=60000
                )
            else:
                raise RuntimeError(
                    "Browser Detector មិនអាចបើក Chromium បានទេ។ "
                    "សូមពិនិត្យ Render Build Command: "
                    "'pip install -r requirements.txt && python -m playwright install chromium'។ "
                    f"ព័ត៌មាន: {str(launch_error)[:350]}"
                ) from launch_error

        context = browser.new_context(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            accept_downloads=False,
            service_workers="block",
        )

        # Block non-public destinations to reduce the risk of browser-based SSRF.
        def guard_request(route):
            try:
                if is_public_http_url(route.request.url):
                    route.continue_()
                else:
                    route.abort()
            except Exception:
                route.abort()

        context.route("**/*", guard_request)
        page = context.new_page()

        def on_response(response):
            try:
                response_url = response.url
                if not is_public_http_url(response_url):
                    return
                parsed = urlparse(response_url)
                content_type = response.headers.get("content-type", "").lower()
                is_mp4 = (
                    "video/mp4" in content_type
                    or parsed.path.lower().endswith(".mp4")
                )
                is_manifest = (
                    "mpegurl" in content_type
                    or "dash+xml" in content_type
                    or parsed.path.lower().endswith((".m3u8", ".mpd"))
                )
                if is_mp4:
                    captured.append(response_url)
                elif is_manifest:
                    captured_manifests.append(response_url)
            except Exception:
                pass

        page.on("response", on_response)
        try:
            page.goto(page_url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(2500)
            page.evaluate("""() => {
                for (const v of document.querySelectorAll('video')) {
                    v.muted = true;
                    const p = v.play();
                    if (p && p.catch) p.catch(() => {});
                }
            }""")
            for selector in [
                "button[aria-label*='play' i]",
                ".vjs-big-play-button", ".plyr__control--overlaid"
            ]:
                try:
                    page.locator(selector).first.click(timeout=1200)
                except Exception:
                    pass
            page.wait_for_timeout(9000)
        finally:
            context.close()
            browser.close()

    logger.info("Browser media scan finished: mp4=%d manifests=%d", len(captured), len(captured_manifests))

    # Prefer a direct MP4; otherwise try a public HLS/DASH manifest.
    if not captured and captured_manifests:
        manifest_url = captured_manifests[-1]
        return download_public_manifest(manifest_url, page_url, folder)
    if not captured:
        raise RuntimeError(
            "Browser Network Monitor មិនបានរកឃើញ MP4, HLS ឬ DASH Manifest ទេ។ "
            "សូមពិនិត្យថា Page បានចាក់វីដេអូរួច និងអាចមើលបានជាសាធារណៈ។"
        )

    media_url = captured[-1]
    if not is_public_http_url(media_url):
        raise RuntimeError("ប្រភព Media មិនអនុញ្ញាតសម្រាប់សុវត្ថិភាពទេ។")

    target = Path(folder) / "browser-detected-video.mp4"
    page_parts = urlparse(page_url)
    # Match the site-root Referer used by FileCoster's browser media request.
    # Some public file hosts reject the full /d/<id> page URL as a hotlink Referer.
    page_referer = f"{page_parts.scheme}://{page_parts.netloc}/"
    request = urllib.request.Request(
        media_url,
        headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            "Referer": page_referer,
            "Accept": "*/*",
        },
    )
    total = 0
    with urllib.request.urlopen(request, timeout=45) as response, target.open("wb") as output:
        content_type = response.headers.get("Content-Type", "").lower()
        if "video/mp4" not in content_type and not response.geturl().lower().split("?")[0].endswith(".mp4"):
            raise RuntimeError("ប្រភពដែលរកឃើញមិនមែនជា MP4 ទេ។")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > 1024 * 1024 * 1024:
                raise RuntimeError("វីដេអូធំជាង 1 GB; បញ្ឈប់ដើម្បីការពារទំហំ Disk។")
            output.write(chunk)

    return _compress_for_telegram(target, folder)




def download_idm_direct_link(media_url: str, folder: str):
    """Download a user-supplied public direct media URL, as copied from IDM."""
    if not is_public_http_url(media_url):
        raise RuntimeError("IDM URL មិនមានសុវត្ថិភាព ឬមិនមែនជា HTTP/HTTPS ទេ។")

    user_agent = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 Chrome/120 Safari/537.36"
    )
    parsed = urlparse(media_url)
    path_ext = Path(parsed.path).suffix.lower()
    allowed_exts = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".ts"}
    disposition_ext = ""

    # Probe with a one-byte Range request so a large file is not downloaded twice.
    probe = urllib.request.Request(
        media_url,
        headers={
            "User-Agent": user_agent,
            "Accept": "*/*",
            "Accept-Encoding": "identity",
            "Range": "bytes=0-0",
        },
    )
    try:
        with urllib.request.urlopen(probe, timeout=30) as response:
            final_url = response.geturl()
            if not is_public_http_url(final_url):
                raise RuntimeError("IDM Link បញ្ជូនទៅ URL មិនមានសុវត្ថិភាពទេ។")
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            disposition = response.headers.get("Content-Disposition", "")
            filename_match = re.search(r"filename[^=]*=[\"']?([^\"';]+)", disposition, re.I)
            if filename_match:
                disposition_ext = Path(filename_match.group(1)).suffix.lower()
            is_media = content_type.startswith("video/") or (
                content_type in {"application/octet-stream", "application/mp4"}
                and (path_ext in allowed_exts or disposition_ext in allowed_exts)
            )
            if not is_media and path_ext not in allowed_exts and disposition_ext not in allowed_exts:
                return None
            content_range = response.headers.get("Content-Range", "")
            if "/" in content_range:
                try:
                    total_size = int(content_range.rsplit("/", 1)[1])
                    if total_size > 1024 * 1024 * 1024:
                        raise RuntimeError("IDM Video ធំជាង 1 GB; បញ្ឈប់ដើម្បីការពារ Disk។")
                except ValueError:
                    pass
            elif response.status == 200:
                length = response.headers.get("Content-Length")
                if length and int(length) > 1024 * 1024 * 1024:
                    raise RuntimeError("IDM Video ធំជាង 1 GB; បញ្ឈប់ដើម្បីការពារ Disk។")
    except urllib.error.HTTPError as exc:
        if exc.code in {401, 403, 404, 410, 416}:
            raise RuntimeError(
                f"IDM Direct Link មិនអាចចូលប្រើបាន (HTTP {exc.code})។ "
                "Link អាចផុតកំណត់ ឬ Server ត្រូវការ Referer/Session ដែលមានសិទ្ធិ។"
            ) from exc
        raise

    suffix = path_ext if path_ext in allowed_exts else (
        disposition_ext if disposition_ext in allowed_exts else ".mp4"
    )
    target = Path(folder) / ("idm-direct-download" + suffix)
    request = urllib.request.Request(
        media_url,
        headers={
            "User-Agent": user_agent,
            "Accept": "*/*",
            "Accept-Encoding": "identity",
        },
    )
    total = 0
    with urllib.request.urlopen(request, timeout=45) as response, target.open("wb") as output:
        if not is_public_http_url(response.geturl()):
            raise RuntimeError("IDM Link Redirect មិនមានសុវត្ថិភាពទេ។")
        response_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if not response_type.startswith("video/") and response_type not in {
            "application/octet-stream", "application/mp4"
        }:
            raise RuntimeError("Link មិនបានបញ្ជូនឯកសារវីដេអូទេ។")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > 1024 * 1024 * 1024:
                raise RuntimeError("IDM Video ធំជាង 1 GB; បញ្ឈប់ដើម្បីការពារ Disk។")
            output.write(chunk)

    if total == 0:
        raise RuntimeError("IDM Link មិនបានបញ្ជូនទិន្នន័យវីដេអូទេ។")
    logger.info("IDM direct media downloaded: %s bytes, type=%s", total, content_type)
    return _compress_for_telegram(target, folder)


def download_video(url: str, folder: str) -> Path:
    # First try the direct media URL copied from IDM.
    direct_result = download_idm_direct_link(url, folder)
    if direct_result is not None:
        return direct_result

    base_options = {
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
        # No cookies, browser profiles, credentials, or access-control bypass.
    }

    host = (urlparse(url).hostname or "").lower()
    is_x_url = host == "x.com" or host.endswith(".x.com") or host in {
        "twitter.com", "www.twitter.com", "mobile.twitter.com"
    }
    attempts = [("default", {})]
    if is_x_url:
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

    # IDM-style fallback runs only after all extractor attempts fail.
    try:
        return resolve_browser_media(url, folder)
    except Exception as browser_error:
        logger.warning("Browser media detection failed: %s", browser_error)
        raise RuntimeError(
            "វិធី Extractor និង IDM Auto Detector សុទ្ធតែមិនអាចទាញយកបាន។ "
            f"មូលហេតុចុងក្រោយ: {str(browser_error)[:300]}"
        ) from browser_error


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
