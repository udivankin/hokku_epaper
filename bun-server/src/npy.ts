// Minimal .npy reader: little-endian float32, C order — enough for the correction LUT.

export function readNpyFloat32(buf: Uint8Array): { shape: number[]; data: Float32Array } {
  const magic = new TextDecoder().decode(buf.subarray(1, 6));
  if (buf[0] !== 0x93 || magic !== "NUMPY") throw new Error("not an .npy file");
  const major = buf[6]!;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(buf.subarray(headerStart, headerStart + headerLen));
  if (!header.includes("'<f4'") || header.includes("'fortran_order': True")) {
    throw new Error(`unsupported .npy header: ${header}`);
  }
  const shape = header
    .match(/'shape':\s*\(([^)]*)\)/)![1]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const start = headerStart + headerLen;
  const count = shape.reduce((a, b) => a * b, 1);
  // Copy so the Float32Array is aligned regardless of the header length.
  const data = new Float32Array(buf.slice(start, start + count * 4).buffer);
  return { shape, data };
}
