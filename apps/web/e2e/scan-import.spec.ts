import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

/**
 * Scan-first (docs/05 §2): a LiDAR scan is a measurement, so it builds the room
 * and the person tidies it — rather than making them draw a room on a phone and
 * correcting it afterwards.
 *
 * This runs against a real Scaniverse export when the fixture is present. Two
 * defects got past unit tests and were only caught by driving the actual UI:
 * the hint's position was measured with a ref that was null on first render, so
 * the "Next" button drew on top of it; and the import confirmation lived inside
 * the empty-board block, so a successful import unmounted the very message that
 * said it had worked.
 */

const FIXTURE = "/tmp/sv_scan.glb";

async function toEmptyBoard(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 12_000 });
  await page.getByTestId("tutorial-skip").click();
  await page.getByTestId("new-room").click();
  await expect(page.getByTestId("drawing-board")).toBeVisible();
}

test("the scan importer is reachable before any drawing has happened", async ({ page }) => {
  await toEmptyBoard(page);
  await expect(page.getByTestId("import-scan")).toBeVisible();
});

test("the hint and the primary action never overlap", async ({ page }) => {
  await toEmptyBoard(page);
  const next = await page.getByTestId("next-button").boundingBox();
  const hint = await page.getByTestId("board-hint").boundingBox();
  expect(next).not.toBeNull();
  expect(hint).not.toBeNull();
  const overlaps =
    next!.x < hint!.x + hint!.width &&
    hint!.x < next!.x + next!.width &&
    next!.y < hint!.y + hint!.height &&
    hint!.y < next!.y + next!.height;
  expect(overlaps, `next=${JSON.stringify(next)} hint=${JSON.stringify(hint)}`).toBe(false);
});

test("a file we cannot read says so instead of going quiet", async ({ page }) => {
  await toEmptyBoard(page);
  await page.setInputFiles('[data-testid="scan-file-input"]', {
    name: "notascan.glb",
    mimeType: "model/gltf-binary",
    buffer: Buffer.from("this is definitely not a GLB file at all"),
  });
  await expect(page.getByTestId("import-note")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("validation-badge")).toContainText("0 walls");
});

test.describe(() => {
  test.skip(!existsSync(FIXTURE), "no scan fixture on this machine");

  test("a real LiDAR scan builds a closed room with measured walls", async ({ page }) => {
    await toEmptyBoard(page);
    await page.setInputFiles('[data-testid="scan-file-input"]', FIXTURE);

    // The confirmation must survive the board filling up.
    await expect(page.getByTestId("import-note")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("import-note")).toContainText("Measured from your scan");

    // The room is closed and has more than four walls — traced, not boxed.
    await expect(page.getByTestId("validation-badge")).toContainText("Closed ✓");
    await expect(page.getByTestId("validation-badge")).toContainText("ft²");
    await expect(page.getByTestId("next-button")).toBeEnabled();

    // The ceiling came from the scan, in feet and inches, not the 8 ft default.
    await expect(page.getByTestId("import-note")).toContainText('"');
  });
});
