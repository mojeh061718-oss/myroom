import { expect, test, type Page } from "@playwright/test";

/**
 * The M4 golden path (docs/03 §8): draw → photograph → build → edit.
 *
 * The static build has no API and no GPU, so this exercises the demo stage
 * driver — which is exactly what CI is meant to cover. The assertions below
 * include the honesty requirement: the screen must say the objects are examples
 * (DECISIONS.md → "Demo reconstruction is labelled").
 */

/** A 1×1 JPEG. Real magic bytes, so the quality check has something to decode. */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

async function drawRoom(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tutorial-skip").click();
  await page.getByTestId("new-room").click();
  await page.getByTestId("drawing-board").waitFor();

  const box = (await page.getByTestId("board-canvas").boundingBox())!;
  const click = (x: number, y: number) =>
    page.mouse.click(box.x + box.width / 2 + 60 * x, box.y + box.height / 2 - 60 * y);
  const w = box.width / 2 / 60 > 3.4 ? 2.6 : 1.8;
  const d = box.height / 2 / 60 > 3.4 ? 1.8 : 1.4;
  await click(-w, d);
  await click(w, d);
  await click(w, -d);
  await click(-w, -d);
  await click(-w, d);
  await page.getByTestId("height-2.44").click();
  await page.waitForTimeout(300);
  return page.url().replace("/draw", "");
}

test("draw → photograph → build → edit", async ({ page }) => {
  const projectUrl = await drawRoom(page);

  await page.goto(`${projectUrl}/capture`);
  await page.getByTestId("capture").waitFor();
  await expect(page.getByTestId("capture-progress")).toContainText("0 of 4 walls");
  // The prompt names the wall the plan says to shoot next.
  await expect(page.getByTestId("capture-prompt")).toContainText("Wall");

  await page.getByTestId("capture-library-input").setInputFiles({
    name: "wall-a.jpg",
    mimeType: "image/jpeg",
    buffer: TINY_JPEG,
  });
  await expect(page.getByTestId("capture-strip").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("capture-progress")).toContainText("1 of 4 walls");

  await page.getByTestId("capture-continue").click();

  // S5 is skippable in one tap, and says so.
  await page.getByTestId("scan-upload").waitFor();
  await expect(page.getByTestId("scan-continue")).toContainText("without a scan");
  await page.getByTestId("scan-continue").click();

  await page.getByTestId("processing").waitFor();
  // Objects are announced by name and size as they land (docs/01 §8).
  await expect(page.getByTestId("processing-found").locator("li").first()).toContainText("Found:", {
    timeout: 20_000,
  });
  // No pretending: the demo path names itself.
  await expect(page.getByTestId("processing-demo")).toContainText("not objects detected in your photos");

  await expect(page.getByTestId("processing-open")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("processing-open").click();

  await page.getByTestId("sandbox").waitFor({ timeout: 25_000 });
  await expect(page.getByTestId("accuracy-badge")).toContainText("Photo-calibrated");

  // Every placed object is a real, editable object (BLUEPRINT §2). The
  // accessible room list is the document's own account of what is in the room,
  // so count furniture there rather than in the render.
  const listed = page.locator(".scene-a11y-list li");
  const furniture = await listed.filter({ hasNotText: /^(Floor|Wall) / }).count();
  expect(furniture).toBeGreaterThan(3);
});

test("a room built with no photos is still a room, and says why it's empty", async ({ page }) => {
  const projectUrl = await drawRoom(page);
  await page.goto(`${projectUrl}/processing`);
  await page.getByTestId("processing").waitFor();
  await expect(page.getByTestId("processing-open")).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId("processing-warnings")).toContainText("add pieces yourself");

  await page.getByTestId("processing-open").click();
  await page.getByTestId("sandbox").waitFor({ timeout: 25_000 });
  // The shell is exact even with nothing in it — never a dead end (docs/05 §8).
  await expect(page.getByTestId("accuracy-badge")).toContainText("Sketch");
});
