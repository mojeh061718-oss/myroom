import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { reconstruct } from "./reconstruct.js";
import { emptyPlan } from "../stores/projectsStore.js";
import { uuidv7 } from "./uuid.js";
import type { RoomPlan } from "@myroom/schema";

/**
 * The accuracy badge is the honesty contract (docs/05 §9). A tier is earned by
 * what was measured, never by what was uploaded.
 *
 * The tier used to be `photos.length > 0 ? "photo" : "sketch"`, so attaching
 * photos awarded "Photo-calibrated" — and its printed promise of "positions
 * within about 6 inches" — to a room whose furniture came from
 * demoMeasuredObjects, which lays out a typical room from the floor plan and
 * never opens a photo. The user who took four photos of their living room got
 * a confident accuracy claim over invented furniture.
 *
 * The same reasoning was already applied to LiDAR one line above: a scan we
 * could not read does not earn the LiDAR tier.
 */

const FT = 0.3048;

function closedRectangle(): RoomPlan {
  const plan = emptyPlan();
  const corners = [
    { x: 0, y: 0 },
    { x: 16 * FT, y: 0 },
    { x: 16 * FT, y: 13 * FT },
    { x: 0, y: 13 * FT },
  ];
  const vertices = corners.map((c) => ({ id: uuidv7(), ...c }));
  return {
    ...plan,
    vertices,
    walls: vertices.map((v, i) => ({
      id: uuidv7(),
      label: String.fromCharCode(65 + i),
      start: v.id,
      end: vertices[(i + 1) % vertices.length]!.id,
      thickness: 0.115,
      height: 8 * FT,
      openings: [],
    })),
    closed: true,
  };
}

function photo(id: string) {
  return {
    id,
    projectId: "p",
    kind: "photo" as const,
    filename: `${id}.jpg`,
    byteSize: 1024,
    sha256: "0".repeat(64),
    status: "stored" as const,
    storageRef: id,
    blob: new Blob([new Uint8Array(8)]),
    createdAt: new Date().toISOString(),
    wallLabel: "A",
    shotId: id,
    quality: null,
    remoteId: null,
  };
}

describe("the accuracy badge never claims more than was measured", () => {
  it('does not award "Photo-calibrated" for photos it never opened', async () => {
    const result = await reconstruct({
      projectId: "p",
      plan: closedRectangle(),
      uploads: [photo("a"), photo("b"), photo("c"), photo("d")],
      scanParsed: false,
      seeds: [],
      onEvent: () => {},
    });

    // Four photos attached, none analysed.
    expect(result.demo).toBe(true);
    expect(result.tier).toBe("sketch");
    expect(result.scene.provenance.tier).toBe("sketch");
  });

  it("still says sketch when there are no photos at all", async () => {
    const result = await reconstruct({
      projectId: "p",
      plan: closedRectangle(),
      uploads: [],
      scanParsed: false,
      seeds: [],
      onEvent: () => {},
    });
    expect(result.tier).toBe("sketch");
  });

  it('does not award "LiDAR-verified" for a scan that named nothing', async () => {
    // A mesh scan (.glb/.ply) parses successfully and returns no seed boxes on
    // purpose: an unlabelled mesh cannot say *what* occupies a volume. The
    // first version of this fix keyed the tier off "did the scan parse", so
    // exactly this case got badged "LiDAR-verified" over invented furniture —
    // the same lie as before with a different word on it.
    const result = await reconstruct({
      projectId: "p",
      plan: closedRectangle(),
      uploads: [photo("a")],
      scanParsed: true,
      seeds: [],
      onEvent: () => {},
    });
    expect(result.tier).toBe("sketch");
    expect(result.scene.provenance.tier).toBe("sketch");
  });

  it("awards the LiDAR tier only when a scan actually named furniture", async () => {
    const seeds = [
      {
        id: uuidv7(),
        category: "sofa",
        position: { x: 1, y: 0, z: 1 },
        size: { w: 2.1, d: 0.9, h: 0.8 },
        rotationY: 0,
        confidence: 0.9,
      },
    ];
    const result = await reconstruct({
      projectId: "p",
      plan: closedRectangle(),
      uploads: [photo("a")],
      scanParsed: true,
      seeds: seeds as never,
      onEvent: () => {},
    });
    expect(result.tier).toBe("lidar");
  });
});
