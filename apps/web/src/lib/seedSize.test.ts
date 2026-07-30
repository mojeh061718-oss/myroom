import { describe, expect, it } from "vitest";
import { getCategory } from "@myroom/catalog";
import { sizeForNamedSeed } from "./seedSize.js";

/**
 * The scan measures a cluttered couch too deep and a small bin too short;
 * the NAME carries what the measurement doesn't. Naming must snap the
 * implausible axes to the category and leave honest measurements alone.
 */
describe("sizeForNamedSeed", () => {
  const sofa = getCategory("sofa")!.defaultSize;

  it("keeps plausible measurements — real furniture varies", () => {
    const measured = { w: sofa.w * 1.2, d: sofa.d * 0.9, h: sofa.h * 1.1 };
    expect(sizeForNamedSeed(measured, "sofa")).toEqual(measured);
  });

  it("snaps clutter-inflated axes to the category", () => {
    // The reference scan's couch: width fine, twice as deep as any couch,
    // measured with a lamp's worth of extra height.
    const measured = { w: sofa.w, d: sofa.d * 2.1, h: sofa.h * 2.2 };
    const fixed = sizeForNamedSeed(measured, "sofa");
    expect(fixed.w).toBe(sofa.w);
    expect(fixed.d).toBe(sofa.d);
    expect(fixed.h).toBe(sofa.h);
  });

  it("snaps under-measured axes too", () => {
    const bin = getCategory("trash-can")!.defaultSize;
    const fixed = sizeForNamedSeed({ w: bin.w, d: bin.d, h: bin.h * 0.3 }, "trash-can");
    expect(fixed.h).toBe(bin.h);
  });

  it("tries both orientations before snapping width and depth", () => {
    // A bookshelf measured sideways: its long axis in the cluster's depth.
    const shelf = getCategory("bookshelf")!.defaultSize;
    const measured = { w: shelf.d, d: shelf.w, h: shelf.h };
    expect(sizeForNamedSeed(measured, "bookshelf")).toEqual(measured);
  });

  it("returns the measurement untouched for unknown categories", () => {
    const measured = { w: 1, d: 2, h: 3 };
    expect(sizeForNamedSeed(measured, "not-a-category")).toEqual(measured);
  });
});
