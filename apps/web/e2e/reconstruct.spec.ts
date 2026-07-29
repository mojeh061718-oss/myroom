import { expect, test, type Page } from "@playwright/test";
import { boardBox } from "./board.js";

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

  const box = await boardBox(page);
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

/**
 * A RoomPlan export is already parametric and metric, so this path needs no GPU
 * at all: the scan corrects the plan and furnishes the room with objects it
 * measured itself (docs/05 §2, §5). This is the M5 acceptance path.
 */
function roomPlanExport(scale = 1.05): string {
  const transform = ([x, y, z]: [number, number, number], yaw = 0) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const rows = [
      [c, 0, s, x],
      [0, 1, 0, y],
      [-s, 0, c, z],
      [0, 0, 0, 1],
    ];
    return [0, 1, 2, 3].flatMap((col) => [0, 1, 2, 3].map((row) => rows[row]![col]!));
  };
  // The drawn room in the E2E is 3.6 × 2.8 m at 2.44 m; the "scan" is the same
  // room measured 5% larger with a slightly lower ceiling.
  const w = 3.6 * scale;
  const d = 2.8 * scale;
  return JSON.stringify({
    walls: [
      { transform: transform([0, 1.16, -d / 2]), dimensions: [w, 2.32, 0.1] },
      { transform: transform([0, 1.16, d / 2]), dimensions: [w, 2.32, 0.1] },
      { transform: transform([-w / 2, 1.16, 0], Math.PI / 2), dimensions: [d, 2.32, 0.1] },
      { transform: transform([w / 2, 1.16, 0], Math.PI / 2), dimensions: [d, 2.32, 0.1] },
    ],
    objects: [
      { transform: transform([0.4, 0.42, -0.9]), dimensions: [2.14, 0.84, 0.92], category: "sofa" },
      { transform: transform([-0.8, 0.37, 0.7]), dimensions: [1.4, 0.74, 0.9], category: "table" },
    ],
  });
}

test("a RoomPlan scan corrects the room and furnishes it from its own measurements", async ({ page }) => {
  const projectUrl = await drawRoom(page);

  await page.goto(`${projectUrl}/scan`);
  await page.getByTestId("scan-upload").waitFor();
  await page.getByTestId("scan-input").setInputFiles({
    name: "room.json",
    mimeType: "application/json",
    buffer: Buffer.from(roomPlanExport()),
  });

  // The preview draws the scan over the plan before anything is uploaded.
  await expect(page.getByTestId("scan-preview")).toBeVisible();
  await expect(page.getByTestId("scan-preview")).toContainText("4 walls and 2 objects");
  await expect(page.getByTestId("scan-continue")).toContainText("Build my room");
  await page.getByTestId("scan-continue").click();

  await page.getByTestId("processing").waitFor();
  await expect(page.getByTestId("processing-open")).toBeEnabled({ timeout: 20_000 });
  // The objects came from the scan, so nothing is presented as a demo.
  await expect(page.getByTestId("processing-warnings")).toContainText("came from your scan");
  await expect(page.getByTestId("processing-demo")).toHaveCount(0);

  await page.getByTestId("processing-open").click();
  await page.getByTestId("sandbox").waitFor({ timeout: 25_000 });
  await expect(page.getByTestId("accuracy-badge")).toContainText("LiDAR-verified");

  const listed = page.locator(".scene-a11y-list li");
  await expect(listed.filter({ hasText: "Sofa" })).toHaveCount(1);
});
