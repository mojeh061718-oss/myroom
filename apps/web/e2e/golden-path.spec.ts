import { expect, test, type Page } from "@playwright/test";
import { boardBox, PPM } from "./board.js";

/**
 * M1 golden path (docs/04 §7 + docs/09 M1): splash → tutorial (skippable) →
 * home → draw a room → typed dimension → openings → undo/redo → closure →
 * height sheet → Next enabled → survives reload (never lose work).
 *
 * Board math: default viewport centers plan (0,0) at screen center with
 * 60 px/m, so plan (x, y) → screen (cx + 60x, cy − 60y).
 */

async function planClick(page: Page, x: number, y: number) {
  const box = await boardBox(page);
  await page.mouse.click(box.x + box.width / 2 + PPM * x, box.y + box.height / 2 - PPM * y);
}

/** Room sized to fit the viewport at the opening zoom (mobile gets a smaller room). */
async function roomSize(page: Page): Promise<{ w: number; h: number }> {
  const box = await boardBox(page);
  const fits = (px: number, m: number) => px / 2 / PPM > m + 0.7;
  return fits(box.width, 4) && fits(box.height, 3) ? { w: 4, h: 3 } : { w: 2.2, h: 1.6 };
}

/** The app is feet-and-inches throughout (docs/04 §4), so the badge is ft². */
/**
 * The badge shows the floor INSIDE the walls (the area you could carpet), not
 * the centreline polygon — one definition, shared with the sandbox, so the same
 * room cannot report two sizes on two screens.
 *
 * So a room drawn w x d along its centrelines encloses (w - t)(d - t) at the
 * default wall thickness.
 */
const THICKNESS = 0.115;
const area = (w: number, d: number) =>
  `${Math.round(((w - THICKNESS) * (d - THICKNESS)) / (0.3048 * 0.3048))} ft²`;

async function toBoard(page: Page) {
  await page.goto("/");
  // Splash auto-advances (≤1.8 s); first launch lands on the tutorial.
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("tutorial-skip").click();
  // Skipping lands on Projects Home in one tap (docs/01 §3).
  await expect(page.getByTestId("home")).toBeVisible();
  await page.getByTestId("new-room").click();
  await expect(page.getByTestId("drawing-board")).toBeVisible();
  await expect(page.getByTestId("board-hint")).toBeVisible();
}

test("draw → close → typed dimension → openings → undo/redo → persist", async ({ page }) => {
  await toBoard(page);

  // Draw a w × h room, counter-clockwise from the origin.
  const { w, h } = await roomSize(page);
  await planClick(page, 0, 0);
  await planClick(page, w, 0);
  await expect(page.getByTestId("validation-badge")).toContainText("Open · 1 wall");
  await planClick(page, w, h);
  await planClick(page, 0, h);
  await expect(page.getByTestId("validation-badge")).toContainText("Open · 3 walls");
  // Closure snap: click the chain origin.
  await planClick(page, 0, 0);

  // Wall-height sheet appears once, after closure (docs/01 §5).
  await page.getByTestId("height-8ft").click();

  await expect(page.getByTestId("validation-badge")).toContainText("Closed ✓");
  await expect(page.getByTestId("validation-badge")).toContainText(area(w, h));
  await expect(page.getByTestId("next-button")).toBeEnabled();

  // Typed dimensions beat drawn ones: stretch wall A (north) by 2.2 m. The
  // suffix is explicit because a bare number is read in the display unit —
  // feet, on this badge.
  const typed = w + 2.2;
  await page.getByTestId("dim-label-A").click();
  const input = page.getByTestId("dimension-input");
  await input.fill(`${typed}m`);
  await input.press("Enter");
  // The correction propagates around the loop (docs/04 §4): the opposite wall
  // follows and the room stays a rectangle at the new width — no trapezoid —
  // so the badge shows exactly the grown rectangle's floor area.
  await expect(page.getByTestId("validation-badge")).toContainText(area(typed, h));

  // Add a door on the south wall and a window on the east wall.
  await page.getByTestId("tool-door").click();
  await planClick(page, w / 2, 0);
  await expect(page.locator('[data-testid="opening-door"]')).toHaveCount(1);
  await page.getByTestId("tool-window").click();
  await planClick(page, w, h / 2);
  await expect(page.locator('[data-testid="opening-window"]')).toHaveCount(1);

  // Undo removes the window; redo restores it (docs/04 §7).
  await page.getByTestId("undo").click();
  await expect(page.locator('[data-testid="opening-window"]')).toHaveCount(0);
  await page.getByTestId("redo").click();
  await expect(page.locator('[data-testid="opening-window"]')).toHaveCount(1);

  // Feet and inches by default; the Units control in Settings can flip to
  // metric (docs/04 §4).
  await expect(page.getByTestId("validation-badge")).toContainText("ft²");
  await expect(page.getByTestId("validation-badge")).not.toContainText("m²");

  // Never lose work: reload and the closed room is still there (IndexedDB).
  await page.waitForTimeout(300); // allow the in-flight IDB transaction to commit
  await page.reload();
  await expect(page.getByTestId("home").or(page.getByTestId("drawing-board"))).toBeVisible({ timeout: 15_000 });
  if (await page.getByTestId("home").isVisible().catch(() => false)) {
    // splash → home (tutorialSeen persisted): open the project card
    await page.getByTestId("project-card").first().click();
  }
  await expect(page.getByTestId("validation-badge")).toContainText("Closed ✓");
  await expect(page.locator('[data-testid="opening-door"]')).toHaveCount(1);
});

test("units toggle in settings flips the display unit and persists (docs/04 §4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("tutorial-skip").click();
  await expect(page.getByTestId("home")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  const units = page.getByRole("group", { name: "Display units" });
  await expect(units.getByRole("button", { name: "ft / in" })).toHaveAttribute("aria-pressed", "true");
  await units.getByRole("button", { name: "m", exact: true }).click();
  await expect(units.getByRole("button", { name: "m", exact: true })).toHaveAttribute("aria-pressed", "true");

  // The choice survives a reload (persisted per user, docs/04 §4).
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByTestId("home")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("group", { name: "Display units" }).getByRole("button", { name: "m", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("input discipline: short walls and crossings are rejected", async ({ page }) => {
  await toBoard(page);
  const { w, h } = await roomSize(page);
  await planClick(page, 0, 0);
  await planClick(page, w, 0);
  // 0.1 m segment → rejected with a visible explanation. (Pause first so the
  // nearby tap isn't interpreted as the double-tap end-chain gesture.)
  await page.waitForTimeout(400);
  await planClick(page, w + 0.1, 0);
  await expect(page.getByText('at least 12"')).toBeVisible();
  await expect(page.getByTestId("validation-badge")).toContainText("1 wall");
  // crossing wall → rejected.
  //
  // Two things this click has to survive. First, the crossing check runs
  // against committed state, so wait for the chain to actually grow rather than
  // racing it. Second, the board snaps the pending point (docs/04 §4) — so aim
  // along an exact 45° from the last vertex, where every snap is a no-op, and
  // far from any vertex the snap could grab. From (w, h) that is (w − h − 1, −1),
  // which crosses the first wall regardless of the room's size.
  await planClick(page, w, h);
  await expect(page.getByTestId("validation-badge")).toContainText("2 walls");
  await page.waitForTimeout(400);
  await planClick(page, w - h - 1, -1);
  await expect(page.getByText("can't cross")).toBeVisible();
  await expect(page.getByTestId("validation-badge")).toContainText("2 walls");
});

test("PWA installability: manifest + service worker are served", async ({ page }) => {
  await page.goto("/");
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).toBeTruthy();
  const manifest = await page.request.get(manifestHref!);
  expect(manifest.ok()).toBeTruthy();
  const json = await manifest.json();
  expect(json.display).toBe("standalone");
  expect(json.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBeTruthy();
  await page.waitForFunction(() => navigator.serviceWorker?.ready.then(() => true), null, { timeout: 20_000 });
});
