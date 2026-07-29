import type { PhotoQuality } from "@myroom/schema";

/**
 * Instant per-photo quality check (docs/01 §6).
 *
 * Runs on the device, on a downscaled copy, so the verdict is back before the
 * thumbnail finishes animating in. A failing photo is never rejected — the
 * guidance is a suggestion, because a blurry photo of a wall is still better
 * evidence than no photo of that wall (docs/05 §8 skips unusable ones later).
 */

/** Below this, the image is soft enough that detection will suffer. */
const SHARPNESS_FLOOR = 0.0018;
const DARK = 0.18;
const BRIGHT = 0.86;
/** Long edge of the working copy — enough detail to judge focus, cheap to scan. */
const SAMPLE_EDGE = 320;

export async function measurePhotoQuality(blob: Blob): Promise<PhotoQuality> {
  const bitmap = await createImageBitmap(blob);
  const scale = SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height);
  const width = Math.max(2, Math.round(bitmap.width * Math.min(1, scale)));
  const height = Math.max(2, Math.round(bitmap.height * Math.min(1, scale)));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return { sharpness: 1, exposure: 0.5, verdict: "good", advice: null };
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, width, height);

  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    luma[p] = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
  }

  return classify(laplacianVariance(luma, width, height), mean(luma));
}

function mean(values: Float32Array): number {
  let total = 0;
  for (const v of values) total += v;
  return values.length ? total / values.length : 0;
}

/**
 * Variance of the Laplacian — the standard focus measure. A sharp image has
 * strong second derivatives at every edge; a blurred one has almost none.
 */
export function laplacianVariance(luma: Float32Array, width: number, height: number): number {
  const responses: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      responses.push(
        4 * luma[i]! - luma[i - 1]! - luma[i + 1]! - luma[i - width]! - luma[i + width]!,
      );
    }
  }
  if (responses.length === 0) return 0;
  const average = responses.reduce((a, b) => a + b, 0) / responses.length;
  return responses.reduce((sum, r) => sum + (r - average) ** 2, 0) / responses.length;
}

export function classify(sharpness: number, exposure: number): PhotoQuality {
  // Exposure first: a photo too dark to see is also too dark to focus-score,
  // so reporting "blurry" for an unlit room would send the user chasing the
  // wrong fix.
  if (exposure < DARK) {
    return { sharpness, exposure, verdict: "dark", advice: "It's quite dark — turn on a light and retake it." };
  }
  if (exposure > BRIGHT) {
    return {
      sharpness,
      exposure,
      verdict: "bright",
      advice: "The window is blowing out the shot — try standing so the light is behind you.",
    };
  }
  if (sharpness < SHARPNESS_FLOOR) {
    return { sharpness, exposure, verdict: "soft", advice: "That one looks soft — hold still and tap to focus." };
  }
  return { sharpness, exposure, verdict: "good", advice: null };
}
