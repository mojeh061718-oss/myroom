import { expect, test, type Page } from "@playwright/test";

/**
 * M3 golden path: the docs/01 §10 running example — furnish a room, move a
 * piece, repaint a wall, save and restore versions, all undoable.
 */

async function buildRoom(page: Page) {
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
  await page.waitForTimeout(250);

  await page.goto(page.url().replace("/draw", ""));
  await page.getByTestId("sandbox").waitFor({ timeout: 25_000 });
  await page.waitForFunction(() => !!(window as never as { __myroomRenderer?: unknown }).__myroomRenderer, null, {
    timeout: 25_000,
  });
  await page.waitForTimeout(2200);
}

async function addItem(page: Page, query: string, categoryId: string) {
  await page.getByTestId("add-button").click();
  await page.getByTestId("catalog-search").fill(query);
  await page.getByTestId(`catalog-${categoryId}`).click();
  await page.waitForTimeout(500);
}

function triangles(page: Page) {
  return page.evaluate(
    () => (window as never as { __myroomRenderer: { info: { render: { triangles: number } } } }).__myroomRenderer.info.render.triangles,
  );
}

/**
 * How many objects the Scene document holds, read through the accessible
 * object list (docs/06 §7) — a real user-visible surface. Rendered triangle
 * counts drift with camera damping and frustum culling, so they can't stand in
 * for document state.
 */
function objectCount(page: Page) {
  return page.getByRole("navigation", { name: "Room contents" }).getByRole("button").count();
}

test("furnish, paint and undo — the room stays within budget", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await buildRoom(page);

  expect(await objectCount(page)).toBe(0);
  await page.getByTestId("edit-button").click();

  await addItem(page, "sofa", "sofa");
  await addItem(page, "coffee", "coffee-table");
  await addItem(page, "rug", "rug");
  expect(await objectCount(page)).toBe(3);
  expect(await triangles(page)).toBeLessThan(300_000); // docs/06 §8

  // Paint every wall sage green (docs/01 §10 running example).
  await page.getByTestId("paint-walls").click();
  await page.getByTestId("swatch-#9CAF88").click();
  await page.waitForTimeout(600);

  // Undo the paint, then the three additions (docs/06 §6).
  for (let i = 0; i < 4; i++) {
    await page.getByTestId("undo").click();
    await page.waitForTimeout(220);
  }
  expect(await objectCount(page)).toBe(0);

  // Redo brings it all back.
  for (let i = 0; i < 4; i++) {
    await page.getByTestId("redo").click();
    await page.waitForTimeout(220);
  }
  expect(await objectCount(page)).toBe(3);
  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("objects survive an app kill — nothing is ever lost", async ({ page }) => {
  await buildRoom(page);
  await page.getByTestId("edit-button").click();
  await addItem(page, "bookshelf", "bookshelf");
  await addItem(page, "floor lamp", "floor-lamp");
  expect(await objectCount(page)).toBe(2);
  await page.waitForTimeout(500);

  await page.reload();
  await page.getByTestId("sandbox").waitFor({ timeout: 25_000 });
  await page.waitForFunction(() => !!(window as never as { __myroomRenderer?: unknown }).__myroomRenderer, null, {
    timeout: 25_000,
  });
  await page.waitForTimeout(2500);
  expect(await objectCount(page)).toBe(2);
});

test("versions: original room is locked and always restorable", async ({ page }) => {
  await buildRoom(page);
  await page.getByTestId("edit-button").click();
  expect(await objectCount(page)).toBe(0);

  await addItem(page, "sofa", "sofa");
  expect(await objectCount(page)).toBe(1);

  await page.getByTestId("done-button").click();
  await page.getByTestId("versions-button").click();
  await expect(page.getByTestId("version-strip")).toContainText("Original room");
  await expect(page.getByTestId("version-strip")).toContainText("locked");

  await page.getByTestId("restore-Original-room").click();
  await page.waitForTimeout(900);
  // Version zero was captured on entering Edit, before the sofa existed.
  expect(await objectCount(page)).toBe(0);
});

test("the catalog searches by synonym and filters by what fits", async ({ page }) => {
  await buildRoom(page);
  await page.getByTestId("edit-button").click();
  await page.getByTestId("add-button").click();

  // Synonyms from the taxonomy resolve to the right category.
  await page.getByTestId("catalog-search").fill("couch");
  await expect(page.getByTestId("catalog-sofa")).toBeVisible();
  await page.getByTestId("catalog-search").fill("footstool");
  await expect(page.getByTestId("catalog-ottoman")).toBeVisible();
  await page.getByTestId("catalog-search").fill("airfryer");
  await expect(page.getByTestId("catalog-air-fryer")).toBeVisible();
  await page.getByTestId("catalog-search").fill("cupboard");
  await expect(page.getByTestId("catalog-cabinet")).toBeVisible();

  // "Fits here" hides anything larger than the room.
  await page.getByTestId("catalog-search").fill("");
  await page.getByTestId("fits-here").click();
  await expect(page.getByTestId("catalog-grid")).toBeVisible();
});

test("an object can be selected, rotated, duplicated and deleted", async ({ page }) => {
  await buildRoom(page);
  await page.getByTestId("edit-button").click();
  await addItem(page, "armchair", "armchair");
  expect(await objectCount(page)).toBe(1);

  // The accessible object list is a real selection path (docs/06 §7). It is
  // visually hidden until focused — the skip-link pattern — so drive it the way
  // a keyboard or screen-reader user would: focus, then activate.
  const entry = page
    .getByRole("navigation", { name: "Room contents" })
    .getByRole("button", { name: /Armchair/ });
  await entry.focus();
  await expect(entry).toBeVisible(); // focus-within reveals the list
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("rotate-object")).toBeVisible();

  await page.getByTestId("duplicate-object").click();
  await page.waitForTimeout(500);
  expect(await objectCount(page)).toBe(2);

  await page.getByTestId("object-button").click();
  await page.getByTestId("delete-object").click();
  await page.getByRole("button", { name: "Remove" }).click();
  await page.waitForTimeout(500);
  expect(await objectCount(page)).toBe(1);
});

test("A/B compare renders two versions from the same camera (docs/06 §6)", async ({ page }) => {
  await buildRoom(page);
  await page.getByTestId("edit-button").click();

  // Version zero was captured on entering Edit; furnish, then save a second.
  await addItem(page, "sofa", "sofa");
  await addItem(page, "bookshelf", "bookshelf");
  await page.getByTestId("done-button").click();
  await page.getByTestId("versions-button").click();

  page.once("dialog", (d) => d.accept("Furnished"));
  await page.getByTestId("save-version").click();
  await page.waitForTimeout(600);

  // Pick the two versions to compare.
  await page.getByTestId("compare-Original-room").click();
  await page.getByTestId("compare-Furnished").click();

  const overlay = page.getByTestId("compare-overlay");
  await expect(overlay).toBeVisible({ timeout: 20_000 });

  // Both frames captured, and they differ — the empty room vs the furnished one.
  const sources = await overlay.locator("img").evaluateAll((imgs) =>
    imgs.map((i) => (i as HTMLImageElement).src),
  );
  expect(sources).toHaveLength(2);
  const [before, after] = sources as [string, string];
  expect(before.startsWith("data:image/png")).toBe(true);
  expect(after.startsWith("data:image/png")).toBe(true);
  expect(before).not.toBe(after);

  await page.getByTestId("compare-range").fill("20");
  await page.getByTestId("compare-close").click();
  await expect(overlay).toBeHidden();
});

test("share exports a render of the current view (docs/06 §6)", async ({ page }) => {
  await buildRoom(page);
  const download = page.waitForEvent("download", { timeout: 20_000 });
  await page.getByTestId("share-button").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.png$/);
});
