import { describe, expect, it } from "vitest";
import { parseLas } from "../src/las.js";

/** Build a minimal, valid LAS file in memory. Coordinates in metres. */
function makeLas(
  points: [number, number, number][],
  {
    versionMinor = 2,
    headerSize = 227,
    recordFormat = 0,
    recordLength = 20,
    legacyCount = points.length,
    scale = 0.001,
  }: {
    versionMinor?: number;
    headerSize?: number;
    recordFormat?: number;
    recordLength?: number;
    legacyCount?: number;
    scale?: number;
  } = {},
): Uint8Array {
  const bytes = new Uint8Array(headerSize + points.length * recordLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4c, 0x41, 0x53, 0x46]); // "LASF"
  bytes[24] = 1;
  bytes[25] = versionMinor;
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  bytes[104] = recordFormat;
  view.setUint16(105, recordLength, true);
  view.setUint32(107, legacyCount, true);
  view.setFloat64(131, scale, true);
  view.setFloat64(139, scale, true);
  view.setFloat64(147, scale, true);
  // offsets at 155/163/171 stay 0
  if (versionMinor >= 4 && headerSize >= 255) {
    view.setBigUint64(247, BigInt(points.length), true);
  }
  points.forEach(([x, y, z], i) => {
    const at = headerSize + i * recordLength;
    view.setInt32(at, Math.round(x / scale), true);
    view.setInt32(at + 4, Math.round(y / scale), true);
    view.setInt32(at + 8, Math.round(z / scale), true);
  });
  return bytes;
}

describe("parseLas (docs/05 §2)", () => {
  it("reads a LAS 1.2 / PDRF 0 file and recentres it Y-up", () => {
    // LAS is Z-up: (x east, y north, z elevation).
    const result = parseLas(
      makeLas([
        [0, 0, 0],
        [2, 0, 0],
        [0, 3, 0],
        [0, 0, 1.5],
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pointCount).toBe(4);
    const p = (i: number) => [result.positions[i * 3]!, result.positions[i * 3 + 1]!, result.positions[i * 3 + 2]!];
    // Relative geometry survives recentring: east stays +x…
    expect(p(1)[0]! - p(0)[0]!).toBeCloseTo(2, 3);
    // …north becomes −z (our plan frame is (x, −z))…
    expect(p(2)[2]! - p(0)[2]!).toBeCloseTo(-3, 3);
    // …and elevation becomes +y.
    expect(p(3)[1]! - p(0)[1]!).toBeCloseTo(1.5, 3);
  });

  it("reads a LAS 1.4 / PDRF 6 file whose count lives in the 64-bit field", () => {
    const result = parseLas(
      makeLas(
        [
          [0, 0, 0],
          [1, 1, 1],
        ],
        { versionMinor: 4, headerSize: 375, recordFormat: 6, recordLength: 30, legacyCount: 0 },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pointCount).toBe(2);
  });

  it("declines LAZ with the export switch to flip", () => {
    const result = parseLas(makeLas([[0, 0, 0]], { recordFormat: 0 | 0xc0 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("LAZ");
  });

  it("declines files that are truncated or not LAS at all", () => {
    expect(parseLas(new Uint8Array(10)).ok).toBe(false);
    const notLas = makeLas([[0, 0, 0]]);
    notLas[0] = 0x58;
    expect(parseLas(notLas).ok).toBe(false);
    // Declared points but the file ends first.
    const short = makeLas([[0, 0, 0]]).slice(0, 227);
    expect(parseLas(short).ok).toBe(false);
  });
});
