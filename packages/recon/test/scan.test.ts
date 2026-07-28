import { describe, expect, it } from "vitest";
import { checkScanFile, parseRoomPlanJson, sniffScanFormat } from "../src/scan.js";

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));

/** A RoomPlan-style column-major 4×4 with a Y rotation. */
function transform([x, y, z]: [number, number, number], yaw = 0): number[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const rowMajor = [
    [c, 0, s, x],
    [0, 1, 0, y],
    [-s, 0, c, z],
    [0, 0, 0, 1],
  ];
  // Column-major serialization: transpose, then flatten.
  return [0, 1, 2, 3].flatMap((col) => [0, 1, 2, 3].map((row) => rowMajor[row]![col]!));
}

describe("scan sniffing (docs/01 §7)", () => {
  it("names the format from the bytes, not the extension", () => {
    expect(sniffScanFormat(ascii("ply\nformat ascii 1.0"))).toBe("ply");
    expect(sniffScanFormat(ascii("glTF"))).toBe("glb");
    expect(sniffScanFormat(ascii("ASTM-E57"))).toBe("e57");
    expect(sniffScanFormat(ascii("LASF"))).toBe("las");
    expect(sniffScanFormat(bytes(0x50, 0x4b, 0x03, 0x04))).toBe("usdz");
    expect(sniffScanFormat(ascii('  {"walls":[]}'))).toBe("roomplan-json");
    expect(sniffScanFormat(bytes(0xff, 0xd8, 0xff))).toBeNull();
  });

  it("refuses files by type, by size and by contents", () => {
    expect(checkScanFile("room.pdf", 100, ascii("%PDF")).ok).toBe(false);
    expect(checkScanFile("room.ply", 600 * 1024 * 1024, ascii("ply")).reason).toContain("500 MB");
    const mismatch = checkScanFile("room.ply", 100, bytes(0xff, 0xd8, 0xff));
    expect(mismatch.ok).toBe(false);
    expect(checkScanFile("room.ply", 100, ascii("ply\n")).ok).toBe(true);
  });
});

describe("RoomPlan preview parsing", () => {
  const doc = {
    walls: [
      { transform: transform([0, 1.22, -1.5]), dimensions: [4, 2.44, 0.1] },
      { transform: transform([0, 1.22, 1.5]), dimensions: [4, 2.44, 0.1] },
      { transform: transform([-2, 1.22, 0], Math.PI / 2), dimensions: [3, 2.44, 0.1] },
      { transform: transform([2, 1.22, 0], Math.PI / 2), dimensions: [3, 2.44, 0.1] },
    ],
    objects: [{ transform: transform([0, 0.4, -1]), dimensions: [2.1, 0.8, 0.9], category: "sofa" }],
  };

  it("recovers wall segments in plan coordinates", () => {
    const preview = parseRoomPlanJson(JSON.stringify(doc))!;
    expect(preview.walls).toHaveLength(4);
    const lengths = preview.walls
      .map((w) => Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]))
      .sort((a, b) => a - b);
    expect(lengths.map((l) => Math.round(l * 100) / 100)).toEqual([3, 3, 4, 4]);
    expect(preview.ceilingHeight).toBeCloseTo(2.44);
    expect(preview.objectCount).toBe(1);
  });

  it("returns null rather than an empty room for something that isn't a scan", () => {
    expect(parseRoomPlanJson("not json")).toBeNull();
    expect(parseRoomPlanJson('{"hello":"world"}')).toBeNull();
    expect(parseRoomPlanJson('{"walls":[]}')).toBeNull();
  });
});
