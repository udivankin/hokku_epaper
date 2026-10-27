# hokku-bun-server

A single-purpose Hokku server for one **Bigme F7** frame, on Bun 1.4.4. The last photo
sent to a Telegram bot (or uploaded over HTTP) is what the frame shows. Nothing else: no web UI, no library,
no scheduling between images, no OTA, no face detection.

It speaks the same wire protocol as the Python server, so the frame needs no change
when you point its URL here.

## What it does

- **Telegram bot** (long polling, in the same process). Allowed users send a photo,
  which goes through the photo pipeline below, or an image **as a file**, which is
  taken as [pre-dithered](PREDITHERED.md) and shown as-is. The bot renders it at once
  and replies with a preview of the result and the time of the next refresh. `/status` reports
  what is on the frame and when it last polled.
- **`GET|POST /hokku/screen/`**: the frame's poll. Returns the 192000-byte panel image
  with `X-Sleep-Seconds` (until the next refresh slot) and `X-Server-Time-Epoch`.
  Before the first photo it answers 404 and asks the frame to retry in 5 minutes.
  The firmware's POSTed activity log is kept in `data/screen.log`.
- **`POST /hokku/api/upload`**: the HTTP equivalent of sending the bot a photo. It
  goes through the same render and replaces what the frame shows next. Needs
  `UPLOAD_TOKEN`, sent as `X-Upload-Token: <token>` or `Authorization: Bearer <token>`.
  Use `X-Upload-Token` behind a proxy that uses `Authorization` for its own basic auth.
  The body is either multipart with the image in `file` (plus an optional `from`), or
  the raw image bytes. `mode` (a form field, or `?mode=` for a raw body) is `photo`
  (default) or `raw` for a [pre-dithered](PREDITHERED.md) image, the same as sending
  the bot a file. The reply is JSON (`orientation`, `mode`, `received_at`, `next_refresh`),
  or the dithered preview PNG if you send `Accept: image/png`. Errors: 400 empty body,
  missing `file` or unknown `mode`, 401 bad token,
  403 uploads disabled, 413 over 25 MB, 422 unreadable image.

  ```bash
  curl -H "X-Upload-Token: $UPLOAD_TOKEN" -F file=@photo.jpg http://localhost:8080/hokku/api/upload
  ```

  The OpenAPI 3.1 schema is [openapi.yaml](openapi.yaml), also served at
  `GET /hokku/api/openapi.yaml`.
- **`GET /hokku/preview.png`**: the current dithered preview. **`GET /healthz`**.

## Image processing

A port of the Python server's "General (default)" preset:

| Stage | Done by |
| --- | --- |
| Decode, EXIF orientation, flatten alpha on white | sharp; `Bun.Image` as a fallback for formats sharp's libvips lacks (HEIC) |
| Crop to fill the panel (or letterbox past `CROP_TO_FILL`) | sharp, Lanczos |
| Gamma 0.88, midtone 1.02, contrast 1.1 | TS |
| CLAHE (clip 1.75, 8×8 tiles) on L* | TS (OpenCV algorithm) |
| Unsharp mask (radius 1, 120 %, threshold 3) | Gaussian blur from sharp, boost in TS |
| OKLAB lightness S-curve into the panel's measured L* 10.21–68.02 | TS |
| F7 gamut-correction LUT (`assets/correction_lut.npy`) and σ=2 noise | TS |
| Atkinson dither (serpentine) onto a hue-aware 6-ink LUT, 180° nibble pack | TS |

The photo's own orientation picks the render: landscape photos fill the panel in
landscape, portrait photos are composed upright and turned into panel memory, so the
frame is rotated to suit the photo. Square photos use `SQUARE_ORIENTATION`.

Not ported: face-aware cropping, the per-image classifier and the separate B&W and
face presets. Every photo gets the general preset.

**Pre-dithered images** (`raw`) skip all of that. At 800×480 or 480×800 each pixel
becomes the nearest ink: pure primaries, the preview palette and the measured glass
colours are all recognised, so a preview PNG sent back comes out byte-identical. Any
other size is cover-cropped and resized, then snapped to the inks with error diffusion
and no tonal changes. See [PREDITHERED.md](PREDITHERED.md), including a prompt for
image generators.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | from @BotFather; without it the bot is off |
| `TELEGRAM_ALLOWED_USERS` | — | comma-separated Telegram user ids |
| `UPLOAD_TOKEN` | — | secret for `/hokku/api/upload`; without it uploads are off |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `DATA_DIR` | `./data` | holds the current image, so it survives a restart |
| `REFRESH_TIMES` | `0600,1200,1800` | local wall-clock slots; set `TZ` if the host is not in yours |
| `CROP_TO_FILL` | `1.0` | largest crop zoom before letterboxing; `0` always letterboxes |
| `SQUARE_ORIENTATION` | `portrait` | |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | for a local Bot API server or tests |

## Run

```bash
bun install
TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USERS=12345 bun start
```

Render a file locally without the server (writes `hokku.bin` and `preview.png`):

```bash
bun run render photo.jpg /tmp/out
```

`bun run typecheck` checks types.

## Replacing the Python server

Run only one Telegram poller per bot token: stop the old bot (`pm2 stop hokku-telegram`)
before starting this one, or Telegram splits the updates between the two. Then stop
`hokku-server.service` and run this on the same port (as a pm2 app or a systemd unit),
and the reverse proxy and the frame's URL can stay as they are.
