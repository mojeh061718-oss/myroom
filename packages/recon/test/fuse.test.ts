import { describe, expect, it } from "vitest";
import type { MeasuredObject } from "@myroom/schema";
import { fuseSeedBoxes, SCANNED_ITEM_CATEGORY } from "../src/fuse.js";
import type { ScanSeedObject } from "../src/scan.js";

let counter = 0;
const newId = () => `fused-${++counter}`;

const measured = (over: Partial<MeasuredObject> = {}): MeasuredObject => ({
  id: "m1",
  category: "sofa",
  position: { x: 1, y: 0, z: -1 },
  rotationY: 0.2,
  size: { w: 2.0, d: 0.85, h: 0.8 },
  support: "floor",
  confidence: 0.7,
  sourcePhotoIds: ["p1"],
  lowConfidence: true,
  palette: ["#7C8B7A"],
  faceTextureRef: null,
  ...over,
});

const seed = (over: Partial<ScanSeedObject> = {}): ScanSeedObject => ({
  category: "sofa",
  position: { x: 1.1, y: 0, z: -1.05 },
  rotationY: 0.0,
  size: { w: 2.14, d: 0.92, h: 0.84 },
  ...over,
});

describe("seed-box fusion (docs/05 §5)", () => {
  it("takes the scan's geometry and keeps the photo's colour", () => {
    const { measured: out, corrected, added } = fuseSeedBoxes([measured()], [seed()], { newId });
    expect(corrected).toBe(1);
    expect(added).toBe(0);
    expect(out[0]!.size).toEqual({ w: 2.14, d: 0.92, h: 0.84 });
    expect(out[0]!.rotationY).toBe(0);
    // The photo saw the colour; the scanner didn't.
    expect(out[0]!.palette).toEqual(["#7C8B7A"]);
    // A measured position confirmed by a scan is no longer low-confidence.
    expect(out[0]!.lowConfidence).toBe(false);
    expect(out[0]!.confidence).toBeGreaterThan(0.7);
  });

  it("does not merge a scan box of a different class", () => {
    const { corrected, added, measured: out } = fuseSeedBoxes(
      [measured()],
      [seed({ category: "dining-table" })],
      { newId },
    );
    expect(corrected).toBe(0);
    expect(added).toBe(1);
    expect(out).toHaveLength(2);
    expect(out[0]!.size.w).toBe(2.0);
  });

  it("furnishes a room from the scan alone", () => {
    const seeds = [
      seed(),
      seed({ category: "dining-table", position: { x: -1, y: 0, z: 2 }, size: { w: 1.4, d: 0.9, h: 0.75 } }),
      seed({ category: "tv", position: { x: 0, y: 1.1, z: 3 }, size: { w: 1.2, d: 0.07, h: 0.7 } }),
    ];
    const { measured: out, added } = fuseSeedBoxes([], seeds, { newId });
    expect(added).toBe(3);
    expect(out.every((o) => o.sourcePhotoIds.length > 0)).toBe(true);
    // Support comes from the taxonomy, not from how high the scanner saw it.
    expect(out.find((o) => o.category === "tv")!.support).toBe("wall");
    expect(out.find((o) => o.category === "sofa")!.support).toBe("floor");
  });

  it("keeps an unnamed box as a measured 'scanned item' rather than dropping it", () => {
    // Dropping unnamed boxes fell the whole room back to invented demo
    // furniture — the measurement is real, only the name is missing
    // (docs/05 §6: never silently omit a detected object).
    const { measured: out, added } = fuseSeedBoxes([], [seed({ category: null })], { newId });
    expect(added).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe(SCANNED_ITEM_CATEGORY);
    expect(out[0]!.support).toBe("floor");
    // Honest about the uncertainty: flagged low-confidence, so the UI offers
    // the "wrong item?" swap.
    expect(out[0]!.lowConfidence).toBe(true);
    expect(out[0]!.confidence).toBeLessThanOrEqual(0.6);
  });

  it("uses an unnamed box to correct an object the photos did name", () => {
    const { measured: out, corrected } = fuseSeedBoxes([measured()], [seed({ category: null })], { newId });
    expect(corrected).toBe(1);
    expect(out[0]!.category).toBe("sofa");
    expect(out[0]!.size.w).toBeCloseTo(2.14);
  });

  it("never lets two objects claim the same scan box", () => {
    const two = [measured(), measured({ id: "m2", position: { x: 1.05, y: 0, z: -1 } })];
    const { corrected, added } = fuseSeedBoxes(two, [seed()], { newId });
    expect(corrected).toBe(1);
    expect(added).toBe(0);
  });
});
