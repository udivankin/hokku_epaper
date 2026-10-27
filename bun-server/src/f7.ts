// Bigme F7 (EK79655, E-Ink Spectra 6) panel spec, ported from
// python/hokku/screens/bigme_f7/display.py.

export const PANEL_W = 800;
export const PANEL_H = 480;
export const PANEL_BYTES = (PANEL_W * PANEL_H) / 2; // 4 bpp

/** Measured on-glass sRGB of the six inks: drives ink selection and the diffused error. */
export const PALETTE_MEASURED: readonly [number, number, number][] = [
  [31, 34, 38], // 0 black
  [185, 199, 201], // 1 white
  [193, 187, 30], // 2 yellow
  [98, 32, 30], // 3 red
  [35, 63, 142], // 4 blue
  [53, 86, 58], // 5 green
];

/** Punchy palette used only for the preview PNG. */
export const PALETTE_PREVIEW: readonly [number, number, number][] = [
  [0, 0, 0],
  [255, 255, 255],
  [255, 230, 50],
  [200, 20, 20],
  [30, 80, 200],
  [20, 120, 40],
];

export const WHITE_INDEX = 1;

/** Palette index → controller nibble (0x4 and 0x7 are undefined on this controller). */
const PALETTE_NIBBLE = [0x0, 0x1, 0x2, 0x3, 0x5, 0x6];

/** Measured black/white L* of this glass: the range the image is compressed into. */
export const DRC_ANCHOR_L: [number, number] = [10.21, 68.02];

/**
 * Palette indices (PANEL_H × PANEL_W, row-major, panel memory orientation) → wire
 * bytes. The panel scan origin is the opposite corner, hence the 180° flip; two
 * pixels per byte, high nibble first.
 */
export function packPanel(idx: Uint8Array): Uint8Array {
  if (idx.length !== PANEL_W * PANEL_H) throw new Error(`expected ${PANEL_W * PANEL_H} indices`);
  const out = new Uint8Array(PANEL_BYTES);
  const last = idx.length - 1;
  for (let i = 0, o = 0; i < idx.length; i += 2, o++) {
    out[o] = (PALETTE_NIBBLE[idx[last - i]!]! << 4) | PALETTE_NIBBLE[idx[last - i - 1]!]!;
  }
  return out;
}
