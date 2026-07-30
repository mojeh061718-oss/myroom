import { expect, test, type Page } from "@playwright/test";
import { boardBox, PPM } from "./board.js";

/**
 * The scan-first promise, end to end (docs/05 §2 + §8): upload a LiDAR point
 * cloud whose session frame is rotated and shifted relative to the drawn
 * plan, review the objects it found, build — and the furniture must land
 * registered onto the drawn walls, exactly where it stands in the real room.
 */

/** A synthetic Polycam-style ASCII PLY: 5.2 × 4 m room, 2.5 m walls, one sofa. */
function roomPly(): Buffer {
  const theta = (30 * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const lines: string[] = [];
  // Room frame (u, v) in plan metres → the scanner's own frame, rotated 30°
  // and 4.5 m away; world is Y-up with plan (x, −z).
  const push = (u: number, v: number, height: number) => {
    const px = u * cos - v * sin + 4.5;
    const py = u * sin + v * cos - 2.0;
    lines.push(`${px.toFixed(3)} ${height.toFixed(3)} ${(-py).toFixed(3)}`);
  };

  for (let u = -2.6; u <= 2.6; u += 0.09) for (let v = -2; v <= 2; v += 0.09) push(u, v, 0);
  for (let t = -2.6; t <= 2.6; t += 0.08)
    for (let h = 0.05; h <= 2.5; h += 0.1) {
      push(t, -2, h);
      push(t, 2, h);
    }
  for (let t = -2; t <= 2; t += 0.08)
    for (let h = 0.05; h <= 2.5; h += 0.1) {
      push(-2.6, t, h);
      push(2.6, t, h);
    }
  // The sofa: 2.0 wide × 0.9 deep × 0.8 tall, centred at (0, 1.5) against the
  // north wall.
  for (let u = -1; u <= 1; u += 0.05) for (let v = 1.05; v <= 1.95; v += 0.05) push(u, v, 0.8);
  for (let u = -1; u <= 1; u += 0.05)
    for (let h = 0.1; h <= 0.8; h += 0.06) {
      push(u, 1.05, h);
      push(u, 1.95, h);
    }
  for (let v = 1.05; v <= 1.95; v += 0.05)
    for (let h = 0.1; h <= 0.8; h += 0.06) {
      push(-1, v, h);
      push(1, v, h);
    }

  const header = `ply\nformat ascii 1.0\nelement vertex ${lines.length}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`;
  return Buffer.from(header + lines.join("\n") + "\n");
}

async function drawRoom(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tutorial-skip").click();
  await page.getByTestId("new-room").click();
  await page.getByTestId("drawing-board").waitFor();
  const box = await boardBox(page);
  const click = (x: number, y: number) =>
    page.mouse.click(box.x + box.width / 2 + PPM * x, box.y + box.height / 2 - PPM * y);
  await click(-2.6, 2);
  await click(2.6, 2);
  await click(2.6, -2);
  await click(-2.6, -2);
  await click(-2.6, 2);
  await page.getByTestId("height-8ft").click();
  await page.waitForTimeout(300);
}

test("a rotated point-cloud scan reviews, registers, and furnishes the drawn room", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "needs a board wide enough for a 5.2 m room");
  await drawRoom(page);

  await page.goto(page.url().replace("/draw", "/scan"));
  await page.getByTestId("scan-upload").waitFor();
  await page.getByTestId("scan-input").setInputFiles({
    name: "living-room.ply",
    mimeType: "application/octet-stream",
    buffer: roomPly(),
  });
  await expect(page.getByTestId("scan-drop")).toContainText("living-room.ply");
  await page.getByTestId("scan-continue").click();

  // The review step: the scan's objects drawn over the plan, tickable.
  await expect(page.getByTestId("seed-review")).toBeVisible({ timeout: 45_000 });
  const items = page.locator('[data-testid^="seed-keep-"]');
  const detected = await items.count();
  expect(detected).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("seed-review-plan")).toBeVisible();

  // The layout question: walls are confirmable, and a missed object can be
  // added by hand — it joins the list ticked.
  await expect(page.getByTestId("review-adjust-walls")).toBeVisible();
  await page.getByTestId("review-add-item").click();
  await expect(items).toHaveCount(detected + 1);
  await expect(page.locator(`[data-testid="seed-keep-${detected}"]`)).toBeChecked();

  // Naming a box in the review is what turns a grey block into furniture:
  // the person in the room says what it is, and it builds as that.
  await page.getByTestId("seed-name-0").selectOption("ottoman");

  await page.getByTestId("review-build").click();
  await expect(page.getByTestId("processing-open")).toBeEnabled({ timeout: 45_000 });
  await page.getByTestId("processing-open").click();
  await page.getByTestId("sandbox").waitFor({ timeout: 25_000 });

  // The sofa-sized box must land where it stands in the room: registered from
  // the scanner's frame onto the drawn plan at (0, −1.5) ± tracing tolerance.
  await page.waitForFunction(() => !!window.__myroomScene?.getObjectByName("objects"), null, { timeout: 25_000 });
  const placed = await page.evaluate(() => {
    const group = (window.__myroomScene as { getObjectByName: (n: string) => { children: { position: { x: number; z: number }; userData: { label?: string } }[] } }).getObjectByName("objects");
    return group.children.map((c) => ({ x: c.position.x, z: c.position.z, label: c.userData.label ?? "" }));
  });
  expect(placed.length).toBeGreaterThanOrEqual(1);
  const sofa = placed.reduce((best, o) =>
    Math.hypot(o.x - 0, o.z + 1.5) < Math.hypot(best.x - 0, best.z + 1.5) ? o : best,
  );
  expect(Math.abs(sofa.x)).toBeLessThan(0.45);
  expect(Math.abs(sofa.z + 1.5)).toBeLessThan(0.45);
  // The named box built as what the user said it is, not as "Scanned item".
  expect(placed.some((o) => o.label.toLowerCase().includes("ottoman"))).toBe(true);
});
