import { expect, type Page } from "@playwright/test";

/** The board's opening zoom — mirrors DEFAULT_PPM in src/screens/board/viewport.ts. */
export const PPM = 80;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The drawing board's canvas rectangle, once it actually has one.
 *
 * Every spec used to write `(await canvas.boundingBox())!`. Playwright returns
 * null from `boundingBox()` whenever the element has no layout box at that
 * instant — which happens on this screen while React re-renders after a
 * validation message appears — and the non-null assertion turned that into
 * `TypeError: Cannot read properties of null (reading 'x')` rather than a wait.
 *
 * It failed roughly one run in three on the "short walls and crossings are
 * rejected" test, i.e. often enough to be a nuisance and rarely enough to look
 * like an unrelated regression whenever it landed.
 *
 * Waiting for visibility is not sufficient on its own: an element can be
 * visible to the auto-waiting assertion and still report no box a moment later,
 * so this polls for a box with real dimensions and gives a diagnosable error if
 * one never arrives.
 */
export async function boardBox(page: Page, testId = "board-canvas"): Promise<Box> {
  const canvas = page.getByTestId(testId);
  await expect(canvas).toBeVisible();

  const deadline = Date.now() + 10_000;
  let last: Box | null = null;
  while (Date.now() < deadline) {
    last = await canvas.boundingBox();
    if (last && last.width > 0 && last.height > 0) return last;
    await page.waitForTimeout(50);
  }
  throw new Error(
    `[data-testid="${testId}"] never reported a layout box (last seen: ${JSON.stringify(last)})`,
  );
}
