<img src="images/readme_banner.png" width="640">

A six-colour e-ink photo frame you feed from Telegram. Send a photo to the bot and the
**Bigme F7** (7.3", E Ink Spectra 6) shows it at its next refresh, cropped to fill the
panel and dithered with colours measured off the real glass.

This is a fork of [defl/hokku_epaper](https://github.com/defl/hokku_epaper) cut down to
one frame and one job. The upstream Python server (web app, photo library, Raspberry Pi
appliance image, Debian package) is gone; a small Bun server replaced it.

## What's here

| Path | What it is |
|---|---|
| [`bun-server/`](bun-server/README.md) | The server: Telegram bot, `POST /hokku/api/upload` ([OpenAPI](bun-server/openapi.yaml)), and the endpoint the frame polls. Bun 1.4.4 + sharp. |
| [`firmware/`](firmware/) | Open firmware for the F7 (XR872) and the other upstream frames, with host test suites. |
| [`tools/`](tools/) | F7 device tools: flashing into the A/B slots, UART console, OEM restore, frame upload over USB. |
| [`python/hokku/`](python/hokku/) | Screen specs and flashing helpers those tools import. |
| [`docs/screens/`](docs/screens/) | Hardware facts, reverse engineering notes and colour measurements per screen. |

## Getting started

1. **Flash the frame** once over USB. Read the STOP rules in [AGENTS.md](AGENTS.md) and
   the [Bigme F7 notes](docs/screens/bigme_f7/README.md) first: a bad flash can brick it.
2. **Run the server** next to a reverse proxy and point the frame's server URL at
   `http://<host>/hokku/screen/`:

   ```bash
   cd bun-server
   bun install
   TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USERS=12345 UPLOAD_TOKEN=... bun start
   ```

3. **Send a photo** to the bot, or upload it:

   ```bash
   curl -H "X-Upload-Token: $UPLOAD_TOKEN" -F file=@photo.jpg http://localhost:8080/hokku/api/upload
   ```

The frame sleeps between refresh slots (06:00, 12:00 and 18:00 by default), so a new
photo appears at the next one. Configuration is in the [server README](bun-server/README.md).

## Colour accuracy

The panel settings come from measuring real panels, not a spec sheet. See
**[Colour accuracy](docs/colour_accuracy.md)** for how it was done.

<table>
<tr>
<td><img src="images/colour/colormunki_on_f7.jpg" width="400"></td>
<td><img src="images/colour/f7_gamut.png" width="360"></td>
</tr>
</table>

## More documentation

- **[Hardware](docs/hardware.md)** — the supported frames and where to buy them.
- **Per-screen documentation** — [Bigme F7](docs/screens/bigme_f7/README.md) · [Hokku / Huessen 13.3"](docs/screens/huessen_epf1301/README.md) · [Seeed reTerminal E1004](docs/screens/seeedstudio_e1004/README.md).
- **[Changelog](CHANGELOG.md)** — upstream release history.
- **[Disclaimer](DISCLAIMER.md)** — warranty (none), intended use, reverse-engineering notes, privacy.

## Background

The firmware, the measurements and the original server are the work of
[@defl](https://github.com/defl) and contributors to
[hokku_epaper](https://github.com/defl/hokku_epaper), where the full story of reverse
engineering these frames is told. [@TaichungLester](https://github.com/TaichungLester)
did the Seeed reTerminal E1004 bring-up there.

---

[![License](https://img.shields.io/badge/license-GPL--3.0%20%2B%20Commons%20Clause-blue)](LICENSE.txt)
