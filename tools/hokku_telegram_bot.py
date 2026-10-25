#!/usr/bin/env python3
"""Telegram bot that adds photos sent to it to a Hokku server's library.

Send the bot a photo (or an image file, which keeps the full resolution) and it
uploads it to Hokku cropped to fill the panel (no letterbox bars), waits for the
conversion, and queues it as the next image for every screen. Screens pick it
up at their next scheduled refresh; a sleeping frame cannot be woken from the
server.

Standard library only, so it runs on any Hokku host without a venv. Run it next
to the server and point it at the local port, which needs no auth:

    TELEGRAM_BOT_TOKEN=...                  # from @BotFather
    TELEGRAM_ALLOWED_USERS=12345,67890      # Telegram user ids allowed to post
    HOKKU_URL=http://127.0.0.1:8080         # default
    python3 tools/hokku_telegram_bot.py

A message from anyone not in TELEGRAM_ALLOWED_USERS is refused, and the reply
tells them their user id so the owner can add it. Commands: /start, /help,
/status.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import PurePosixPath

log = logging.getLogger("hokku_telegram_bot")

POLL_TIMEOUT_S = 50  # Telegram long-poll; the HTTP timeout is set a bit above it
CONVERT_TIMEOUT_S = 180
# Per-photo crop-to-fill override: the largest allowed zoom, so every photo is
# cropped to fill the panel instead of letterboxed (phone photos need ~0.25).
CROP_TO_FILL = 1.0
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp", ".tif", ".tiff"}

HELP = (
    "Send me a photo and I'll put it on the frame.\n\n"
    "Tip: send it as a *file* (paperclip → File) to keep full resolution; "
    "Telegram shrinks ordinary photos to 1280 px, which is still plenty for the panel.\n\n"
    "The frame shows it at its next scheduled refresh.\n"
    "/status — screens and when they refresh next"
)


class Telegram:
    def __init__(self, token: str) -> None:
        self.api = f"https://api.telegram.org/bot{token}/"
        self.files = f"https://api.telegram.org/file/bot{token}/"

    def call(self, method: str, http_timeout: float = 30, **params) -> dict:
        data = urllib.parse.urlencode(
            {k: json.dumps(v) if isinstance(v, (dict, list)) else v for k, v in params.items()}
        ).encode()
        with urllib.request.urlopen(self.api + method, data=data, timeout=http_timeout) as r:
            body = json.load(r)
        if not body.get("ok"):
            raise RuntimeError(f"telegram {method}: {body.get('description')}")
        return body["result"]

    def download(self, file_id: str) -> tuple[bytes, str]:
        path = self.call("getFile", file_id=file_id)["file_path"]
        with urllib.request.urlopen(self.files + path, timeout=120) as r:
            return r.read(), path

    def reply(self, msg: dict, text: str) -> None:
        self.call(
            "sendMessage",
            chat_id=msg["chat"]["id"],
            text=text,
            parse_mode="Markdown",
            reply_parameters={"message_id": msg["message_id"]},
        )


class Hokku:
    def __init__(self, base_url: str) -> None:
        self.base = base_url.rstrip("/")

    def _json(self, method: str, path: str, data: bytes | None = None, headers=None) -> dict:
        req = urllib.request.Request(
            self.base + path, data=data, method=method, headers=headers or {}
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            try:
                detail = json.load(e).get("error", "")
            except ValueError:
                detail = ""
            raise RuntimeError(f"Hokku {path} -> HTTP {e.code} {detail}".strip()) from e

    def status(self) -> dict:
        return self._json("GET", "/hokku/api/status")

    def upload(self, name: str, data: bytes) -> None:
        boundary = uuid.uuid4().hex
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        body = (
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
                f"Content-Type: {ctype}\r\n\r\n"
            ).encode()
            + data
            + f"\r\n--{boundary}--\r\n".encode()
        )
        res = self._json(
            "POST",
            "/hokku/api/upload",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        if name not in res.get("saved", []):
            reasons = "; ".join(s.get("reason", "?") for s in res.get("skipped", [])) or "not saved"
            raise RuntimeError(f"upload refused: {reasons}")

    def wait_converted(self, name: str) -> None:
        deadline = time.monotonic() + CONVERT_TIMEOUT_S
        while time.monotonic() < deadline:
            for f in self.status().get("upload_files", []):
                if f.get("name") != name:
                    continue
                if f.get("status") == "ok":
                    return
                if f.get("status") == "failed":
                    raise RuntimeError(f"conversion failed: {f.get('error')}")
            time.sleep(2)
        raise RuntimeError(f"conversion still running after {CONVERT_TIMEOUT_S} s")

    def set_crop_to_fill(self, name: str, threshold: float) -> None:
        self._json(
            "PATCH",
            "/hokku/api/image/" + urllib.parse.quote(name) + "/config",
            data=json.dumps({"crop_to_fill_threshold": threshold}).encode(),
            headers={"Content-Type": "application/json"},
        )

    def show_next(self, name: str) -> None:
        self._json("POST", "/hokku/api/show_next/" + urllib.parse.quote(name))


def screens_summary(status: dict) -> str:
    screens = status.get("screens") or {}
    if not screens:
        return "No screens have checked in yet."
    lines = []
    for name, s in sorted(screens.items()):
        bat = s.get("battery_percent")
        bat_txt = f", battery {bat}%" if bat is not None else ""
        lines.append(f"• {name}: next refresh {s.get('next_update_at') or '?'}{bat_txt}")
    return "\n".join(lines) + "\n(server time)"


def pick_file(msg: dict) -> tuple[str, str] | None:
    """Return (file_id, extension) for a photo or image document, else None."""
    if msg.get("photo"):
        return msg["photo"][-1]["file_id"], ".jpg"  # largest size is last
    doc = msg.get("document")
    if doc:
        ext = PurePosixPath(doc.get("file_name") or "").suffix.lower()
        if ext in IMAGE_EXTS or (doc.get("mime_type") or "").startswith("image/"):
            return doc["file_id"], ext or mimetypes.guess_extension(
                doc.get("mime_type", "")
            ) or ".jpg"
    return None


def handle(tg: Telegram, hokku: Hokku, allowed: set[int], msg: dict) -> None:
    user = msg.get("from") or {}
    uid = user.get("id")
    if uid not in allowed:
        log.warning("refused message from user id %s (@%s)", uid, user.get("username"))
        tg.reply(msg, f"Not authorised. Your Telegram user id is `{uid}`.")
        return

    text = (msg.get("text") or "").strip()
    if text.startswith(("/start", "/help")):
        tg.reply(msg, HELP)
        return
    if text.startswith("/status"):
        tg.reply(msg, screens_summary(hokku.status()))
        return

    picked = pick_file(msg)
    if picked is None:
        tg.reply(msg, "Send me a photo or an image file. /help for more.")
        return
    file_id, ext = picked
    name = f"tg_{time.strftime('%Y%m%d_%H%M%S')}_{msg['message_id']}{ext}"
    try:
        data, _ = tg.download(file_id)
        log.info("user %s sent %s (%d bytes)", uid, name, len(data))
        hokku.upload(name, data)
        hokku.set_crop_to_fill(name, CROP_TO_FILL)
        hokku.wait_converted(name)
        hokku.show_next(name)
    except Exception as e:  # report any failure back to the sender
        log.exception("failed to add %s", name)
        tg.reply(msg, f"Couldn't add that photo: {e}")
        return
    tg.reply(msg, f"Added as `{name}` and queued next.\n{screens_summary(hokku.status())}")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        print("TELEGRAM_BOT_TOKEN is not set", file=sys.stderr)
        return 2
    allowed = {
        int(u)
        for u in os.environ.get("TELEGRAM_ALLOWED_USERS", "").replace(" ", "").split(",")
        if u
    }
    if not allowed:
        log.warning("TELEGRAM_ALLOWED_USERS is empty: every sender is refused (and told their id)")
    tg = Telegram(token)
    hokku = Hokku(os.environ.get("HOKKU_URL", "http://127.0.0.1:8080"))
    me = tg.call("getMe")
    log.info(
        "running as @%s; %d allowed user(s); Hokku at %s", me["username"], len(allowed), hokku.base
    )

    offset = 0
    while True:
        try:
            updates = tg.call(
                "getUpdates",
                http_timeout=POLL_TIMEOUT_S + 10,
                timeout=POLL_TIMEOUT_S,
                offset=offset,
                allowed_updates=["message"],
            )
        except Exception:  # network blips must not kill the bot
            log.exception("getUpdates failed; retrying in 5 s")
            time.sleep(5)
            continue
        for u in updates:
            offset = u["update_id"] + 1
            msg = u.get("message")
            if msg:
                try:
                    handle(tg, hokku, allowed, msg)
                except Exception:  # one bad update must not stop the loop
                    log.exception("handler failed for update %s", u["update_id"])


if __name__ == "__main__":
    sys.exit(main())
