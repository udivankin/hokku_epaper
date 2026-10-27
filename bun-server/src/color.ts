// Colour-space helpers, ported from python/hokku/webserver/dither_streaming.py and
// image_renderer.py so a render here matches the Python server's maths.
// All functions write into a caller-supplied `out` to avoid per-pixel allocation.

export type Vec3 = Float64Array;

const REF_X = 0.95047;
const REF_Y = 1.0;
const REF_Z = 1.08883;

export function srgbToLinear(v: number): number {
  const c = Math.min(Math.max(v, 0), 255) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb255(v: number): number {
  const c = Math.min(Math.max(v, 0), 1);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.min(Math.max(s * 255, 0), 255);
}

/** sRGB [0,255] → CIELAB (D65), same constants as the Python rgb_to_lab. */
export function rgbToLab(r: number, g: number, b: number, out: Vec3): Vec3 {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / REF_X;
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / REF_Y;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / REF_Z;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
  return out;
}

/** CIELAB → sRGB [0,255] float (the Python ImageRenderer._lab_to_rgb). */
export function labToRgb(L: number, a: number, bb: number, out: Vec3): Vec3 {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - bb / 200;
  const eps = 0.008856;
  const kappa = 903.3;
  const fx3 = fx * fx * fx;
  const fz3 = fz * fz * fz;
  const x = (fx3 > eps ? fx3 : (116 * fx - 16) / kappa) * REF_X;
  const y = (L > kappa * eps ? fy * fy * fy : L / kappa) * REF_Y;
  const z = (fz3 > eps ? fz3 : (116 * fz - 16) / kappa) * REF_Z;
  out[0] = linearToSrgb255(3.2404542 * x - 1.5371385 * y - 0.4985314 * z);
  out[1] = linearToSrgb255(-0.969266 * x + 1.8760108 * y + 0.041556 * z);
  out[2] = linearToSrgb255(0.0556434 * x - 0.2040259 * y + 1.0572252 * z);
  return out;
}

/** sRGB [0,255] → OKLAB (Bottosson 2020). */
export function rgbToOklab(r: number, g: number, b: number, out: Vec3): Vec3 {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return out;
}

/** OKLAB → sRGB [0,255] float, clipped to gamut in linear light. */
export function oklabToRgb(L: number, a: number, b: number, out: Vec3): Vec3 {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  out[0] = linearToSrgb255(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  out[1] = linearToSrgb255(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  out[2] = linearToSrgb255(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return out;
}
