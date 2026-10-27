# Hardware

What Hokku runs on: one or more **e-paper frames**, and one **server** that feeds
them. You can mix different frame models against the same server and the same
photo library.

## Supported frames

| Frame | Size | Price | Board | Status |
|---|---|---|---|---|
| [**Hokku / Huessen 13.3"**](#hokku--huessen-133) | 13.3" | from ~$279 | ESP32-S3 | ✅ Fully supported — the original, most thoroughly tested |
| [**Bigme F7**](#bigme-f7) | 7.3" | ~$99 | XR872AT | ✅ Supported — proven end-to-end on real hardware |
| [**Seeed reTerminal E1004**](#seeed-reterminal-e1004) | 13.3" | ~$288 | ESP32-S3 | ✅ Supported — confirmed working by multiple users |

All three use **E Ink Spectra 6** — the same six-ink family (black, white, yellow,
red, blue, green), so the same photo library and conversion pipeline serves all of
them.

---

## Hokku / Huessen 13.3"

<img src="../images/screen.png" width="400">

The frame this project started with, and the one with the most hours on it. Sold
under both the **Hokku Designs** and **Huessen** brands — identical hardware,
different retailer.

The Wayfair listing is the one confirmed to contain the exact hardware this
firmware targets; the others are likely the same but have not been independently
verified.

| Retailer | Listing | Price | Confirmed |
|----------|---------|------:|:---------:|
| Amazon | [Hokku Designs 13.3" WiFi E-Paper Art Photo Frame](https://amzn.to/3Rs4DXs) | $299 | |
| Wayfair | [Hokku Designs 13.3" WiFi E-Paper Art Photo Frame](https://www.wayfair.com/decor-pillows/pdp/hokku-designs-133-inch-wifi-epaper-art-photo-frame-w115006181.html) | $290 | ✓ |
| Macy's | [Huessen 13.3" WiFi E-Paper Art Digital Photo Frame](https://www.macys.com/shop/product/huessen-13.3-inch-wifi-epaper-art-digital-photo-frame?ID=23769763) | $279 | |
| Best Buy | [Huessen 13.3" E-Ink Digital Photo Frame](https://www.bestbuy.com/product/huessen-13-3-e-ink-digital-photo-frame-full-color-anti-glare-display-app-control-wall-mounted-aluminum-frame-white/J3KVWY3Q9L) | $340 | |
| eco4life | [13.3" WiFi E-Ink Art Photo Frame](https://mall.eco4lifehome.com/products/13-3-inch-wifi-e-ink-art-photo-frame-smart-epaper-digital-display-with-app-control-cloud-sync-no-glare-no-light-pollution-ultra-low-power-ideal-for-home-office-decor) | $380 | |

**What to check before buying**

- **Size**: 13.3". Smaller or larger frames from the same brand family are different hardware and are not compatible.
- **Six colours**: the listing should mention red, yellow, blue and green as well as black and white. Black/white or black/white/red frames use different display technology and are not compatible.
- **WiFi**: 2.4 GHz. The frame does not support 5 GHz networks.

**→ [Full documentation for this screen](screens/huessen_epf1301/README.md)**

---

## Bigme F7

The cheapest way into Hokku at around **$99**, and the only non-ESP32 frame
supported: it runs an
**XRADIOTECH XR872AT**, which took a full reverse-engineering effort to support
(see the [reverse-engineering overview](screens/bigme_f7/reverse_engineering_overview.md)).
Custom firmware, A/B OTA updates, battery reporting and mDNS all work — proven
end-to-end on real hardware.

**Any F7 variant works.** Bigme sells the F7, F7 Lite, F7 Plus, F7 Pro, F7 Max,
F7 Ultra, F7 SE and F7+ — per the manufacturer's own FCC equivalence letter
(FCC ID `2A8EM-F7`) these **share identical PCB and hardware** and differ only by
sales region. Buy whichever variant is cheapest or available where you are.

| Retailer | Listing | Price |
|----------|---------|------:|
| Amazon | [Bigme F7 7.3" colour e-ink frame](https://amzn.to/4wL9dPm) | $99 |

Made by Bigme Cloud Literacy Technology Co., Ltd.; also sold directly and through
the usual marketplaces.

**→ [Full documentation for this screen](screens/bigme_f7/README.md)**

> **Read before you buy:** turning a stock F7 into a Hokku frame requires a
> one-time USB flash that replaces the vendor firmware, and it is a more involved
> process than the ESP32 frames — see
> [Bigme F7 bootstrap](screens/bigme_f7/bootstrap.md). Going back to stock is
> documented in [restore to stock](screens/bigme_f7/restore_to_stock.md), but
> treat this as a one-way trip unless you're comfortable with the recovery
> procedure.

---

## Seeed reTerminal E1004

> ✅ **Supported — confirmed working by multiple users.** First confirmed end-to-end in
> [issue #14](https://github.com/defl/hokku_epaper/issues/14) (flash, WiFi,
> server fetch, panel render and battery reporting), and since run by several
> other users on their own units.

A 13.3" Spectra 6 panel on a Seeed XIAO ESP32-S3, on the reTerminal E-Series
baseboard. Same panel family and resolution as the Hokku/Huessen frame.

| Retailer | Listing | Price |
|----------|---------|------:|
| Seeed Studio | [reTerminal E1004](https://www.seeedstudio.com/reTerminal-E1004-p-6692.html) | $288 |

The panel bring-up work this port is based on was contributed by
[@TaichungLester](https://github.com/TaichungLester) in
[PR #16](https://github.com/defl/hokku_epaper/pull/16).

**→ [Full documentation for this screen](screens/seeedstudio_e1004/README.md)**

---

## The Server

The server is [`bun-server/`](../bun-server/README.md): one small Bun process that runs
the Telegram bot and answers the frame. Anything that runs Bun 1.4.4 will do — the
existing VPS, a Raspberry Pi, a NAS. It renders one photo at a time in about half a
second; rendering a 26-megapixel photo peaked at about 250 MB of RAM.

## Anything else?

**2.4 GHz WiFi is required.** None of the supported frames — and not the Pi Zero
2 W — support 5 GHz. Most routers broadcast both; either SSID is fine as long as
2.4 GHz is enabled.

**A data-capable USB cable** is needed for the one-time firmware flash. Charge-only
cables are common and won't work; if nothing appears when you plug in, try
another cable.

If you buy from a listing not covered here — or get a frame working that isn't on
this page at all — please [open an issue](https://github.com/defl/hokku_epaper/issues)
with what you bought and whether it worked. It'll get added either way.

---

> Prices checked 2026-07-21, except eco4life (2026-05-12). Prices fluctuate and
> vary by retailer and sale.
