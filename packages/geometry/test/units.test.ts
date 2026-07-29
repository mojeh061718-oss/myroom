import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatLength, formatArea, parseDisplayLength, parseLength, roundForDisplay } from "../src/units.js";

describe("parseLength (docs/04 §4 examples)", () => {
  it("parses every documented form", () => {
    expect(parseLength("3.76")).toBeCloseTo(3.76, 9);
    expect(parseLength("3.76m")).toBeCloseTo(3.76, 9);
    expect(parseLength("376cm")).toBeCloseTo(3.76, 9);
    expect(parseLength(`12'4"`)).toBeCloseTo(12 * 0.3048 + 4 * 0.0254, 9);
    expect(parseLength("12ft 4in")).toBeCloseTo(12 * 0.3048 + 4 * 0.0254, 9);
    expect(parseLength("12' 4\"")).toBeCloseTo(12 * 0.3048 + 4 * 0.0254, 9);
    expect(parseLength("12'")).toBeCloseTo(12 * 0.3048, 9);
    expect(parseLength('4"')).toBeCloseTo(4 * 0.0254, 9);
    expect(parseLength("2,44")).toBeCloseTo(2.44, 9);
    expect(parseLength("2440mm")).toBeCloseTo(2.44, 9);
  });

  it("rejects garbage and non-positive lengths", () => {
    for (const bad of ["", "abc", "-3", "0", "0m", "3.7.6", "12'4'", "m"]) {
      expect(parseLength(bad), bad).toBeNull();
    }
  });

  it("reads a bare number in the display unit the user is looking at", () => {
    // Typing "12" against a label reading 12'4" must mean feet, not meters.
    expect(parseLength("12", "ft")).toBeCloseTo(12 * 0.3048, 9);
    expect(parseLength("9", "ft")).toBeCloseTo(9 * 0.3048, 9);
    expect(parseLength("12", "m")).toBeCloseTo(12, 9);
    expect(parseLength("12")).toBeCloseTo(12, 9); // default stays metric
    expect(parseDisplayLength("9", "ft")).toBeCloseTo(9 * 0.3048, 9);
  });

  it("explicit suffixes beat the display unit", () => {
    expect(parseLength("3.76m", "ft")).toBeCloseTo(3.76, 9);
    expect(parseLength("376cm", "ft")).toBeCloseTo(3.76, 9);
    expect(parseLength(`12'4"`, "m")).toBeCloseTo(12 * 0.3048 + 4 * 0.0254, 9);
    expect(parseLength("2440mm", "ft")).toBeCloseTo(2.44, 9);
  });

  it("accepts a leading decimal point", () => {
    expect(parseLength(".5 m")).toBeCloseTo(0.5, 9);
    expect(parseLength(",5")).toBeCloseTo(0.5, 9);
    expect(parseLength(".5", "ft")).toBeCloseTo(0.5 * 0.3048, 9);
  });
});

describe("format ⇄ parse round-trips (docs/04 §7)", () => {
  const meters = fc.double({ min: 0.3, max: 30, noNaN: true, noDefaultInfinity: true });

  it("metric round-trips to mm precision", () => {
    fc.assert(
      fc.property(meters, (m) => {
        const parsed = parseDisplayLength(formatLength(m, "m"));
        expect(parsed).not.toBeNull();
        expect(Math.abs(parsed! - m)).toBeLessThanOrEqual(0.0005 + 1e-9);
      }),
    );
  });

  it("imperial round-trips to ¼-inch precision", () => {
    fc.assert(
      fc.property(meters, (m) => {
        const parsed = parseDisplayLength(formatLength(m, "ft"));
        expect(parsed).not.toBeNull();
        // formatting rounds to nearest ¼" (0.00635 m) → error ≤ half of that
        expect(Math.abs(parsed! - m)).toBeLessThanOrEqual(0.0254 / 8 + 1e-9);
      }),
    );
  });

  it("roundForDisplay is idempotent", () => {
    fc.assert(
      fc.property(meters, fc.constantFrom<"m" | "ft">("m", "ft"), (m, u) => {
        const once = roundForDisplay(m, u);
        expect(roundForDisplay(once, u)).toBeCloseTo(once, 12);
      }),
    );
  });
});

describe("formatting details", () => {
  it("shows trailing-zero centimeters (6.20 m, not 6.2 m)", () => {
    expect(formatLength(6.2, "m")).toBe("6.20 m");
    expect(formatLength(3.762, "m")).toBe("3.762 m");
  });
  it("formats imperial with fractions", () => {
    expect(formatLength(12 * 0.3048 + 4 * 0.0254, "ft")).toBe(`12'4"`);
    expect(formatLength(0.0254 * 4.25, "ft")).toBe(`4¼"`);
    expect(formatLength(0.3048 * 2, "ft")).toBe("2'");
  });
  it("formats areas per docs/04 §5", () => {
    expect(formatArea(29.76, "m")).toBe("29.8 m²");
    expect(formatArea(29.76, "ft")).toBe("320 ft²");
  });
});
