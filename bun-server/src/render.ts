// Photo → Bigme F7 panel bytes.
//
// A port of the Python server's render chain with its shipped "General (default)"
// preset (python/hokku/webserver/presets.py `_general_default`):
//
//   decode + EXIF orient (sharp; Bun.Image as fallback for formats sharp lacks)
//   → crop to fill / letterbox (sharp, Lanczos)
//   → gamma 0.88, midtone 1.02, contrast 1.1, CLAHE 1.75 on L*, unsharp mask
//   → rotate into panel memory when the photo is portrait
//   → OKLAB lightness S-curve into the panel's measured L* range
//   → 3-D gamut-correction LUT → light noise
//   → Atkinson error diffusion (serpentine) onto a hue-aware 6-ink LUT
//   → nibble pack with the panel's 180° scan flip.
//
// Face detection, per-image classification and the B&W / face presets are left out.

import sharp from "sharp";
import { clahe } from "./clahe";
import { labToRgb, oklabToRgb, rgbToLab, rgbToOklab } from "./color";
import {
  DRC_ANCHOR_L,
  PALETTE_MEASURED,
  PALETTE_PREVIEW,
  PANEL_H,
  PANEL_W,
  WHITE_INDEX,
  packPanel,
} from "./f7";
import { readNpyFloat32 } from "./npy";

export type Orientation = "landscape" | "portrait";

export const CONFIG = {
  gamma: 0.88,
  midtone: 1.02,
  contrast: 1.1,
  claheClipLimit: 1.75,
  usmRadius: 1.0,
  usmPercent: 120,
  usmThreshold: 3,
  drcSigmoidK: 7.0,
  ditherNoise: 2.0,
  hueCutoffDeg: 95.0,
  neutralChroma: 8.0,
  serpentine: true,
} as const;

// Pre-shrink bound for the decoded source: plenty of oversampling for the panel,
// without holding a 48 MP buffer through the rest of the chain.
const MAX_SOURCE_SIDE = 2400;
const MAX_INPUT_PIXELS = 40_000_000;

export interface RenderOptions {
  /** Largest cover-crop zoom (cover/fit - 1) before letterboxing instead; 0 = always letterbox. */
  cropToFill: number;
  /** Orientation used for square photos. */
  squareOrientation: Orientation;
}

export interface Rendered {
  panel: Uint8Array;
  orientation: Orientation;
  /** Dithered result in the viewing orientation, using the preview palette. */
  previewPng: Buffer;
}

// ── Decode ─────────────────────────────────────────────────────────────────

async function decodeToRgb(input: Uint8Array): Promise<{ data: Buffer; w: number; h: number }> {
  const run = (bytes: Uint8Array) =>
    sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" })
      .autoOrient()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .resize(MAX_SOURCE_SIDE, MAX_SOURCE_SIDE, { fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  let res;
  try {
    res = await run(input);
  } catch (err) {
    // sharp's prebuilt libvips has no HEVC decoder; Bun.Image uses the platform's
    // codecs, so let it transcode what sharp cannot read (HEIC from iPhones, ...).
    let png: Uint8Array;
    try {
      png = await new Bun.Image(input).png().bytes();
    } catch {
      throw err;
    }
    res = await run(png);
  }
  return { data: res.data, w: res.info.width, h: res.info.height };
}

// ── Fit / crop ─────────────────────────────────────────────────────────────

async function composeCanvas(
  src: { data: Buffer; w: number; h: number },
  vw: number,
  vh: number,
  cropToFill: number,
): Promise<{ rgb: Uint8Array; mask: Uint8Array | null }> {
  const { w: sw, h: sh } = src;
  const fit = Math.min(vw / sw, vh / sh);
  const cover = Math.max(vw / sw, vh / sh);
  const useCover = cropToFill > 0 && cover / fit - 1 <= cropToFill;
  const img = () => sharp(src.data, { raw: { width: sw, height: sh, channels: 3 } });

  if (useCover) {
    const scaledW = Math.max(vw, Math.ceil(sw * cover));
    const scaledH = Math.max(vh, Math.ceil(sh * cover));
    const rgb = await img()
      .resize(scaledW, scaledH, { fit: "fill", kernel: "lanczos3" })
      .extract({
        left: Math.floor((scaledW - vw) / 2),
        top: Math.floor((scaledH - vh) / 2),
        width: vw,
        height: vh,
      })
      .raw()
      .toBuffer();
    return { rgb: new Uint8Array(rgb), mask: null };
  }

  // Letterbox on white; the padding is forced to white ink after dithering.
  const nw = Math.max(1, Math.floor(sw * fit));
  const nh = Math.max(1, Math.floor(sh * fit));
  const scaled = await img().resize(nw, nh, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
  const rgb = new Uint8Array(vw * vh * 3).fill(255);
  const mask = new Uint8Array(vw * vh).fill(1);
  const xo = Math.floor((vw - nw) / 2);
  const yo = Math.floor((vh - nh) / 2);
  for (let y = 0; y < nh; y++) {
    rgb.set(scaled.subarray(y * nw * 3, (y + 1) * nw * 3), ((yo + y) * vw + xo) * 3);
    mask.fill(0, (yo + y) * vw + xo, (yo + y) * vw + xo + nw);
  }
  return { rgb, mask };
}

// ── Tonal enhancements (uint8, viewing orientation) ─────────────────────────

function applyLut(rgb: Uint8Array, lut: Uint8Array): void {
  for (let i = 0; i < rgb.length; i++) rgb[i] = lut[rgb[i]!]!;
}

/** PIL ImageEnhance.Contrast: blend against the mean grey of the luma image. */
function contrast(rgb: Uint8Array, factor: number): void {
  let sum = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    sum += (rgb[i]! * 19595 + rgb[i + 1]! * 38470 + rgb[i + 2]! * 7471 + 0x8000) >> 16;
  }
  const mean = Math.floor(sum / (rgb.length / 3) + 0.5);
  for (let i = 0; i < rgb.length; i++) {
    rgb[i] = Math.min(255, Math.max(0, Math.trunc(mean + factor * (rgb[i]! - mean))));
  }
}

/** CLAHE on the L* channel (8-bit, OpenCV scaling), leaving a* and b* untouched. */
function claheOnLightness(rgb: Uint8Array, w: number, h: number, clipLimit: number): void {
  const n = w * h;
  const L8 = new Uint8Array(n);
  const ab = new Float32Array(n * 2);
  const v = new Float64Array(3);
  for (let p = 0; p < n; p++) {
    rgbToLab(rgb[p * 3]!, rgb[p * 3 + 1]!, rgb[p * 3 + 2]!, v);
    L8[p] = Math.min(255, Math.max(0, Math.round((v[0]! * 255) / 100)));
    ab[p * 2] = v[1]!;
    ab[p * 2 + 1] = v[2]!;
  }
  const eq = clahe(L8, w, h, clipLimit);
  for (let p = 0; p < n; p++) {
    labToRgb((eq[p]! * 100) / 255, ab[p * 2]!, ab[p * 2 + 1]!, v);
    rgb[p * 3] = Math.round(v[0]!);
    rgb[p * 3 + 1] = Math.round(v[1]!);
    rgb[p * 3 + 2] = Math.round(v[2]!);
  }
}

/** PIL-style UnsharpMask: Gaussian blur from sharp, thresholded boost here. */
async function unsharp(rgb: Uint8Array, w: number, h: number): Promise<void> {
  const blurred = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .blur(CONFIG.usmRadius)
    .raw()
    .toBuffer();
  const k = CONFIG.usmPercent / 100;
  for (let i = 0; i < rgb.length; i++) {
    const diff = rgb[i]! - blurred[i]!;
    if (Math.abs(diff) >= CONFIG.usmThreshold) {
      rgb[i] = Math.min(255, Math.max(0, Math.round(rgb[i]! + diff * k)));
    }
  }
}

const GAMMA_LUT = Uint8Array.from({ length: 256 }, (_, i) => Math.trunc((i / 255) ** CONFIG.gamma * 255));
const MIDTONE_LUT = Uint8Array.from({ length: 256 }, (_, i) =>
  i > 0 ? Math.round(255 * (i / 255) ** (1 / CONFIG.midtone)) : 0,
);

async function enhance(rgb: Uint8Array, w: number, h: number): Promise<void> {
  applyLut(rgb, GAMMA_LUT);
  applyLut(rgb, MIDTONE_LUT);
  contrast(rgb, CONFIG.contrast);
  claheOnLightness(rgb, w, h, CONFIG.claheClipLimit);
  await unsharp(rgb, w, h);
}

// ── Rotation between viewing and panel orientation ──────────────────────────

/** Rotate a w×h raster (c channels) 90° clockwise → h×w. */
function rotateCw<T extends Uint8Array>(src: T, w: number, h: number, c: number): T {
  const dst = new (src.constructor as new (n: number) => T)(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (x * h + (h - 1 - y)) * c;
      const s = (y * w + x) * c;
      for (let k = 0; k < c; k++) dst[d + k] = src[s + k]!;
    }
  }
  return dst;
}

/** Rotate a w×h raster (c channels) 90° counter-clockwise → h×w. */
function rotateCcw<T extends Uint8Array>(src: T, w: number, h: number, c: number): T {
  const dst = new (src.constructor as new (n: number) => T)(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = ((w - 1 - x) * h + y) * c;
      const s = (y * w + x) * c;
      for (let k = 0; k < c; k++) dst[d + k] = src[s + k]!;
    }
  }
  return dst;
}

// ── Float prep: saturation round-trip, DRC, correction LUT, noise ───────────

/** OKLAB L of the greys whose CIELAB L* is nearest the panel's measured black/white. */
const DRC_ANCHORS_OKLAB: [number, number] = (() => {
  const v = new Float64Array(3);
  const pick = (target: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let g = 0; g < 256; g++) {
      const d = Math.abs(rgbToLab(g, g, g, v)[0]! - target);
      if (d < bestD) [best, bestD] = [g, d];
    }
    return rgbToOklab(best, best, best, v)[0]!;
  };
  return [pick(DRC_ANCHOR_L[0]), pick(DRC_ANCHOR_L[1])];
})();

function scurve(t: number, k: number): number {
  const raw = 1 / (1 + Math.exp(-k * (t - 0.5)));
  const raw0 = 1 / (1 + Math.exp(k * 0.5));
  const raw1 = 1 / (1 + Math.exp(-k * 0.5));
  return (raw - raw0) / (raw1 - raw0);
}

const CORRECTION_LUT = await (async () => {
  const file = Bun.file(new URL("../assets/correction_lut.npy", import.meta.url));
  const { shape, data } = readNpyFloat32(new Uint8Array(await file.arrayBuffer()));
  if (shape.length !== 4 || shape[3] !== 3) throw new Error(`bad correction LUT shape ${shape}`);
  return { n: shape[0]!, data };
})();

function applyCorrection(rgb: Float64Array): void {
  const { n, data } = CORRECTION_LUT;
  const scale = 255 / (n - 1);
  const at = (r: number, g: number, b: number, c: number) => data[((r * n + g) * n + b) * 3 + c]!;
  const i0 = [0, 0, 0];
  const f = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const coord = Math.min(Math.max(rgb[c]!, 0), 255) / scale;
    i0[c] = Math.min(Math.max(Math.floor(coord), 0), n - 2);
    f[c] = coord - i0[c]!;
  }
  const [r0, g0, b0] = i0 as [number, number, number];
  const [fr, fg, fb] = f as [number, number, number];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - fr) + at(r0 + 1, g0, b0, c) * fr;
    const c10 = at(r0, g0 + 1, b0, c) * (1 - fr) + at(r0 + 1, g0 + 1, b0, c) * fr;
    const c01 = at(r0, g0, b0 + 1, c) * (1 - fr) + at(r0 + 1, g0, b0 + 1, c) * fr;
    const c11 = at(r0, g0 + 1, b0 + 1, c) * (1 - fr) + at(r0 + 1, g0 + 1, b0 + 1, c) * fr;
    rgb[c] = (c00 * (1 - fg) + c10 * fg) * (1 - fb) + (c01 * (1 - fg) + c11 * fg) * fb;
  }
}

function gaussian(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function prepFloat(rgb: Uint8Array): Float32Array {
  const out = new Float32Array(rgb.length);
  const v = new Float64Array(3);
  const [lo, hi] = DRC_ANCHORS_OKLAB;
  for (let i = 0; i < rgb.length; i += 3) {
    // Adaptive saturation runs in OKLAB at a max boost of 1.0 in this preset, so
    // only its gamut-clipping round trip remains; the DRC then maps L into the
    // panel's reachable range. Chroma scaling and adaptive vivid are off.
    rgbToOklab(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!, v);
    oklabToRgb(v[0]!, v[1]!, v[2]!, v);
    rgbToOklab(v[0]!, v[1]!, v[2]!, v);
    const t = Math.min(Math.max(v[0]!, 0), 1);
    oklabToRgb(lo + (hi - lo) * scurve(t, CONFIG.drcSigmoidK), v[1]!, v[2]!, v);
    applyCorrection(v);
    for (let c = 0; c < 3; c++) {
      const noisy = v[c]! + gaussian() * CONFIG.ditherNoise;
      out[i + c] = Math.min(255, Math.max(0, noisy));
    }
  }
  return out;
}

// ── Dither ──────────────────────────────────────────────────────────────────

const LUT_STEPS = 32;
const LUT_SCALE = 256 / LUT_STEPS;

/** 32³ RGB grid → nearest ink in CIELAB, forbidding coloured inks far off the pixel's hue. */
const HUE_AWARE_LUT: Uint8Array = (() => {
  const v = new Float64Array(3);
  const pal = PALETTE_MEASURED.map(([r, g, b]) => Array.from(rgbToLab(r, g, b, v)));
  const palChroma = pal.map(([, a, b]) => Math.hypot(a!, b!));
  const palHue = pal.map(([, a, b]) => Math.atan2(b!, a!));
  const lut = new Uint8Array(LUT_STEPS ** 3);
  for (let ri = 0; ri < LUT_STEPS; ri++) {
    for (let gi = 0; gi < LUT_STEPS; gi++) {
      for (let bi = 0; bi < LUT_STEPS; bi++) {
        const [L, a, b] = rgbToLab(
          ri * LUT_SCALE + LUT_SCALE / 2,
          gi * LUT_SCALE + LUT_SCALE / 2,
          bi * LUT_SCALE + LUT_SCALE / 2,
          v,
        ) as unknown as [number, number, number];
        const chroma = Math.hypot(a, b);
        const hue = Math.atan2(b, a);
        let best = 0;
        let bestD = Infinity;
        for (let p = 0; p < pal.length; p++) {
          if (chroma > CONFIG.neutralChroma && palChroma[p]! >= CONFIG.neutralChroma) {
            const dh = Math.abs(Math.atan2(Math.sin(hue - palHue[p]!), Math.cos(hue - palHue[p]!)));
            if ((dh * 180) / Math.PI > CONFIG.hueCutoffDeg) continue;
          }
          const d = (L - pal[p]![0]!) ** 2 + (a - pal[p]![1]!) ** 2 + (b - pal[p]![2]!) ** 2;
          if (d < bestD) [best, bestD] = [p, d];
        }
        lut[(ri * LUT_STEPS + gi) * LUT_STEPS + bi] = best;
      }
    }
  }
  return lut;
})();

const ATKINSON: readonly [number, number, number][] = [
  [1, 0, 1 / 8],
  [2, 0, 1 / 8],
  [-1, 1, 1 / 8],
  [0, 1, 1 / 8],
  [1, 1, 1 / 8],
  [0, 2, 1 / 8],
];

/** Error diffusion over a float RGB buffer (consumed in place). */
function atkinson(buf: Float32Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const max = LUT_STEPS - 1;
  for (let y = 0; y < h; y++) {
    const reverse = CONFIG.serpentine && y % 2 === 0;
    for (let s = 0; s < w; s++) {
      const x = reverse ? w - 1 - s : s;
      const i = (y * w + x) * 3;
      const r = Math.min(Math.max(buf[i]!, 0), 255);
      const g = Math.min(Math.max(buf[i + 1]!, 0), 255);
      const b = Math.min(Math.max(buf[i + 2]!, 0), 255);
      const idx =
        HUE_AWARE_LUT[
          (Math.min(Math.trunc(r / LUT_SCALE), max) * LUT_STEPS + Math.min(Math.trunc(g / LUT_SCALE), max)) *
            LUT_STEPS +
            Math.min(Math.trunc(b / LUT_SCALE), max)
        ]!;
      out[y * w + x] = idx;
      const ink = PALETTE_MEASURED[idx]!;
      const er = r - ink[0];
      const eg = g - ink[1];
      const eb = b - ink[2];
      for (const [dx, dy, wgt] of ATKINSON) {
        const nx = x + (reverse ? -dx : dx);
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        const j = (ny * w + nx) * 3;
        buf[j]! += er * wgt;
        buf[j + 1]! += eg * wgt;
        buf[j + 2]! += eb * wgt;
      }
    }
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function renderPhoto(input: Uint8Array, opts: RenderOptions): Promise<Rendered> {
  const src = await decodeToRgb(input);
  const orientation: Orientation =
    src.w > src.h ? "landscape" : src.h > src.w ? "portrait" : opts.squareOrientation;
  const portrait = orientation === "portrait";
  // The panel memory is natively landscape; a portrait photo is composed upright
  // and turned into panel memory, the way the frame is turned to show it.
  const [vw, vh] = portrait ? [PANEL_H, PANEL_W] : [PANEL_W, PANEL_H];

  let { rgb, mask } = await composeCanvas(src, vw, vh, opts.cropToFill);
  await enhance(rgb, vw, vh);
  if (portrait) {
    rgb = rotateCw(rgb, vw, vh, 3);
    if (mask) mask = rotateCw(mask, vw, vh, 1);
  }

  const idx = atkinson(prepFloat(rgb), PANEL_W, PANEL_H);
  if (mask) for (let p = 0; p < idx.length; p++) if (mask[p]) idx[p] = WHITE_INDEX;

  const view = portrait ? rotateCcw(idx, PANEL_W, PANEL_H, 1) : idx;
  const preview = new Uint8Array(view.length * 3);
  for (let p = 0; p < view.length; p++) preview.set(PALETTE_PREVIEW[view[p]!]!, p * 3);
  const previewPng = await sharp(preview, { raw: { width: vw, height: vh, channels: 3 } })
    .png()
    .toBuffer();

  return { panel: packPanel(idx), orientation, previewPng };
}
