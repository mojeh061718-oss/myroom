import { describe, expect, it } from "vitest";
import { classify, laplacianVariance } from "./photoQuality.js";

/** A checkerboard: maximum second-derivative energy. */
function checkerboard(size: number, cell: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[y * size + x] = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0.15 : 0.85;
    }
  }
  return out;
}

/** The same image after a 3×3 box blur, which is what camera shake looks like. */
function blur(source: Float32Array, size: number, passes = 4): Float32Array {
  let current = source;
  for (let p = 0; p < passes; p++) {
    const next = new Float32Array(current.length);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let total = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            total += current[ny * size + nx]!;
            count++;
          }
        }
        next[y * size + x] = total / count;
      }
    }
    current = next;
  }
  return current;
}

describe("photo quality (docs/01 §6)", () => {
  it("scores a blurred photo far below a sharp one", () => {
    const sharp = checkerboard(64, 4);
    const soft = blur(sharp, 64);
    expect(laplacianVariance(sharp, 64, 64)).toBeGreaterThan(laplacianVariance(soft, 64, 64) * 10);
  });

  it("reports exposure problems before focus, and always with advice", () => {
    // A dark photo can't be focus-scored, so telling the user it's blurry would
    // send them chasing the wrong fix.
    const dark = classify(0, 0.05);
    expect(dark.verdict).toBe("dark");
    expect(dark.advice).toContain("light");

    const bright = classify(0, 0.95);
    expect(bright.verdict).toBe("bright");

    const soft = classify(0.0001, 0.5);
    expect(soft.verdict).toBe("soft");
    expect(soft.advice).toBeTruthy();
  });

  it("passes a well-exposed sharp photo with nothing to say", () => {
    const good = classify(laplacianVariance(checkerboard(64, 4), 64, 64), 0.5);
    expect(good.verdict).toBe("good");
    expect(good.advice).toBeNull();
  });
});
