# Pre-dithered images

The photo pipeline is tuned for camera photos. It raises contrast, sharpens, adds
noise and dithers. On artwork already made for e-ink, such as dashboards, posters or
pixel art, the same steps add speckle and turn white paper pink. Images like that go
through the **raw** path instead, which skips all processing and maps each pixel to the
panel's nearest ink.

## Sending one

- **Telegram:** send the image **as a file** (paperclip → File). Telegram keeps a file's
  bytes as they are; an ordinary photo is recompressed and always takes the photo
  pipeline.
- **HTTP:** add `mode=raw`.

  ```bash
  curl -H "X-Upload-Token: $UPLOAD_TOKEN" -F file=@poster.png -F mode=raw \
    https://<host>/hokku/api/upload
  ```

- **Locally**, to check the result first: `bun src/cli.ts --raw poster.png out/`
  writes `out/preview.png`.

## What the raw path does

| Input | Result |
| --- | --- |
| 800×480 or 480×800 | Each pixel → the nearest ink, nothing else. A preview PNG from this server comes back byte-identical. |
| Any other size | Cover-cropped to the panel's 5:3, resized (Lanczos), then snapped to the inks with Atkinson error diffusion. Flat ink-coloured areas stay solid; only the blends made by resizing get dithered. |

Orientation comes from the image's shape, as for photos.

**Inks the raw path recognises.** Use pure primaries: `#000000`, `#FFFFFF`, `#FF0000`,
`#FFFF00`, `#0000FF`, `#00FF00`. The server's preview palette and the measured panel
colours are matched too.

**Use PNG for 1-pixel dithers.** JPEG stores colour at half resolution, so a
pixel-level red/green dither comes back as yellow mush. Flat colour and coarse patterns
survive JPEG fine.

## Prompt for GPT Image / Nano Banana

Image generators can't draw a pixel-exact 800×480 dither. They work at about
1024–1536 px and soften every edge. So ask for **flat six-colour artwork with coarse
patterns**: the raw path resizes it and snaps the soft edges back to ink.

- **Size:** GPT Image: `1536x1024` (landscape) or `1024x1536` (portrait). Nano Banana:
  aspect ratio `3:2` or `2:3`.
- **Cropping:** both sizes are slightly off the panel's 5:3. The raw path trims about
  5 % from each long edge, so keep text and faces away from them.

```text
Create a {landscape 3:2 | portrait 2:3} image of: {SUBJECT}.

It will be shown on a 6-colour e-ink screen, so draw it as a flat screen-print poster:
- Use ONLY these six solid colours: black #000000, white #FFFFFF, red #FF0000,
  yellow #FFFF00, blue #0000FF, green #00FF00. No other colours, tints or greys.
- No gradients, soft shadows, glow, blur, textures, film grain or photographic detail.
- Show mixed colours and shading with coarse, regular patterns of the six colours:
  halftone dots, stripes or cross-hatching, each dot or line at least 4 pixels wide.
  Orange = red + yellow dots, sky blue = blue + white, pink/skin = red + white,
  grey = black + white, brown = red + black.
- Bold black outlines, large simple shapes, a plain white background.
- Text, if any: few words, large, bold sans-serif, black on white.
- Keep everything important away from the outer 6 % of the {top and bottom | left and right} edges.
```

Then send the generated PNG to the bot **as a file**, or upload it with `mode=raw`.
If it comes back looking muddy, the model probably used extra colours or gradients.
Ask it to "redo with only the six listed colours and no gradients".
