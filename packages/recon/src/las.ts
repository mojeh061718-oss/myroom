/**
 * LAS point-cloud reader (docs/05 §2) — pure TypeScript, no dependencies.
 *
 * LAS is the ASPRS survey interchange format some scanner apps and most
 * terrestrial scanners export. The format is simple enough to read directly:
 * a fixed header (magic "LASF", scale + offset doubles, a point-record
 * table), then fixed-width records whose first 12 bytes are always X, Y, Z
 * as scaled int32s — true for every point data record format 0–10, across
 * LAS 1.2–1.4.
 *
 * LAZ (compressed LAS) is detected and declined with an actionable message:
 * the decompressor is a large native codebase, not something to vendor for a
 * format the exporting app can simply switch off.
 *
 * Axes: LAS is Z-up (x east, y north, z elevation); this codebase is Y-up
 * with plan coordinates (x, −z). So world = (x, z, −y). Survey files carry
 * georeferenced coordinates in the millions of metres, which would destroy
 * float32 precision — points are recentred on their centroid first.
 */

export type LasDecodeResult =
  | { ok: true; positions: Float32Array; pointCount: number }
  | { ok: false; reason: string };

/** Read at most this many points — a room needs shape, not a survey archive. */
export const MAX_LAS_POINTS = 2_000_000;

export function parseLas(bytes: Uint8Array): LasDecodeResult {
  if (bytes.length < 227) {
    return { ok: false, reason: "that LAS file is truncated" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x4c || bytes[1] !== 0x41 || bytes[2] !== 0x53 || bytes[3] !== 0x46) {
    return { ok: false, reason: "that file doesn't look like a LAS scan inside" };
  }

  const versionMajor = bytes[24]!;
  const versionMinor = bytes[25]!;
  if (versionMajor !== 1 || versionMinor < 1 || versionMinor > 4) {
    return { ok: false, reason: `LAS ${versionMajor}.${versionMinor} isn't a version we can read` };
  }

  const headerSize = view.getUint16(94, true);
  const pointOffset = view.getUint32(96, true);
  const rawFormat = bytes[104]!;
  // LAZ flags compression in the two top bits of the record format byte.
  if ((rawFormat & 0xc0) !== 0) {
    return { ok: false, reason: "that's a compressed LAZ file — export it as LAS or PLY instead" };
  }
  const recordLength = view.getUint16(105, true);
  if (recordLength < 12) {
    return { ok: false, reason: "that LAS file's point records are too small to hold coordinates" };
  }

  let pointCount = view.getUint32(107, true);
  if (pointCount === 0 && versionMinor >= 4 && headerSize >= 255) {
    // LAS 1.4 moved the real count to a 64-bit field; clamp to what fits.
    const big = view.getBigUint64(247, true);
    pointCount = Number(big > 0x7fffffffn ? 0x7fffffffn : big);
  }
  if (pointCount === 0) {
    return { ok: false, reason: "that LAS file declares no points" };
  }

  const scaleX = view.getFloat64(131, true);
  const scaleY = view.getFloat64(139, true);
  const scaleZ = view.getFloat64(147, true);
  const offX = view.getFloat64(155, true);
  const offY = view.getFloat64(163, true);
  const offZ = view.getFloat64(171, true);
  if (!(scaleX > 0) || !(scaleY > 0) || !(scaleZ > 0)) {
    return { ok: false, reason: "that LAS file has a broken coordinate scale" };
  }

  const available = Math.floor((bytes.length - pointOffset) / recordLength);
  const usable = Math.min(pointCount, available);
  if (usable <= 0) {
    return { ok: false, reason: "that LAS file ends before its points start" };
  }

  const stride = Math.max(1, Math.ceil(usable / MAX_LAS_POINTS));
  const n = Math.floor((usable + stride - 1) / stride);

  // First pass in float64 for the centroid — georeferenced coordinates are
  // too large for float32.
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const zs = new Float64Array(n);
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (let i = 0, j = 0; j < n; i += stride, j++) {
    const at = pointOffset + i * recordLength;
    const x = view.getInt32(at, true) * scaleX + offX;
    const y = view.getInt32(at + 4, true) * scaleY + offY;
    const z = view.getInt32(at + 8, true) * scaleZ + offZ;
    xs[j] = x;
    ys[j] = y;
    zs[j] = z;
    sumX += x;
    sumY += y;
    sumZ += z;
  }
  const cx = sumX / n;
  const cy = sumY / n;
  const cz = sumZ / n;

  // LAS Z-up → this codebase's Y-up: world = (x, z, −y), recentred.
  const positions = new Float32Array(n * 3);
  for (let j = 0; j < n; j++) {
    positions[j * 3] = xs[j]! - cx;
    positions[j * 3 + 1] = zs[j]! - cz;
    positions[j * 3 + 2] = -(ys[j]! - cy);
  }
  return { ok: true, positions, pointCount: n };
}
