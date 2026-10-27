// CLAHE on an 8-bit single channel, following OpenCV's createCLAHE(clipLimit, (8, 8))
// (clip + uniform redistribution, then bilinear interpolation between tile LUTs).

export function clahe(src: Uint8Array, w: number, h: number, clipLimit: number, tiles = 8): Uint8Array {
  if (w % tiles || h % tiles) throw new Error(`CLAHE needs dimensions divisible by ${tiles}`);
  const tw = w / tiles;
  const th = h / tiles;
  const area = tw * th;
  const clip = Math.max(1, Math.floor((clipLimit * area) / 256));
  const lutScale = 255 / area;
  const luts = new Uint8Array(tiles * tiles * 256);
  const hist = new Int32Array(256);

  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      hist.fill(0);
      for (let y = ty * th; y < (ty + 1) * th; y++) {
        const row = y * w;
        for (let x = tx * tw; x < (tx + 1) * tw; x++) hist[src[row + x]!]!++;
      }
      let clipped = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i]! > clip) {
          clipped += hist[i]! - clip;
          hist[i] = clip;
        }
      }
      const batch = Math.floor(clipped / 256);
      let residual = clipped - batch * 256;
      for (let i = 0; i < 256; i++) hist[i]! += batch;
      if (residual) {
        const step = Math.max(Math.floor(256 / residual), 1);
        for (let i = 0; i < 256 && residual > 0; i += step, residual--) hist[i]!++;
      }
      const base = (ty * tiles + tx) * 256;
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        sum += hist[i]!;
        luts[base + i] = Math.min(255, Math.round(sum * lutScale));
      }
    }
  }

  const dst = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const tyf = y / th - 0.5;
    let ty1 = Math.floor(tyf);
    const ya = tyf - ty1;
    const ty2 = Math.min(ty1 + 1, tiles - 1);
    ty1 = Math.max(ty1, 0);
    for (let x = 0; x < w; x++) {
      const txf = x / tw - 0.5;
      let tx1 = Math.floor(txf);
      const xa = txf - tx1;
      const tx2 = Math.min(tx1 + 1, tiles - 1);
      tx1 = Math.max(tx1, 0);
      const v = src[y * w + x]!;
      const l11 = luts[(ty1 * tiles + tx1) * 256 + v]!;
      const l12 = luts[(ty1 * tiles + tx2) * 256 + v]!;
      const l21 = luts[(ty2 * tiles + tx1) * 256 + v]!;
      const l22 = luts[(ty2 * tiles + tx2) * 256 + v]!;
      const res = (l11 * (1 - xa) + l12 * xa) * (1 - ya) + (l21 * (1 - xa) + l22 * xa) * ya;
      dst[y * w + x] = Math.min(255, Math.max(0, Math.round(res)));
    }
  }
  return dst;
}
