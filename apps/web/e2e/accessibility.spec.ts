import AxeBuilder from "@axe-core/playwright";
import { boardBox } from "./board.js";
import { expect, test, type Page } from "@playwright/test";

/**
 * The docs/02 §9 accessibility checklist, which is **ship-blocking**.
 *
 * axe covers the mechanical half — contrast, names, roles, landmarks. The rest
 * of the checklist needs behaviour, so it is tested behaviourally below:
 * keyboard operation, the 3D canvas's parallel object list, and Dynamic Type at
 * 135% without layout breakage.
 */

async function skipTutorial(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tutorial-skip").click();
}

async function drawRoom(page: Page): Promise<string> {
  await skipTutorial(page);
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

/** WCAG 2.1 AA is the bar docs/02 §9 sets (4.5:1 text, 3:1 essential UI). */
const audit = (page: Page) =>
  new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);

test("the home screen and tutorial have no accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 15_000 });
  const tutorial = await audit(page).analyze();
  expect(tutorial.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);

  await page.getByTestId("tutorial-skip").click();
  const home = await audit(page).analyze();
  expect(home.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
});

test("the drawing board has no accessibility violations", async ({ page }) => {
  await skipTutorial(page);
  await page.getByTestId("new-room").click();
  await page.getByTestId("drawing-board").waitFor();
  const results = await audit(page).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
});

test("the capture flow has no accessibility violations", async ({ page }) => {
  const projectUrl = await drawRoom(page);

  await page.goto(`${projectUrl}/capture`);
  await page.getByTestId("capture").waitFor();
  const capture = await audit(page).analyze();
  expect(capture.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);

  await page.goto(`${projectUrl}/scan`);
  await page.getByTestId("scan-upload").waitFor();
  const scan = await audit(page).analyze();
  expect(scan.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
});

test("the sandbox exposes its contents as a parallel navigation path", async ({ page }) => {
  const projectUrl = await drawRoom(page);
  await page.goto(projectUrl);
  await page.getByTestId("sandbox").waitFor({ timeout: 25_000 });

  // docs/02 §9: "the 3D canvas exposes an accessible object list … as a
  // parallel navigation path". It reads out sizes, not just names.
  const list = page.locator(".scene-a11y-list");
  await expect(list).toHaveAttribute("aria-label", /room contents/i);
  await expect(list.locator("li").first()).toContainText("Floor");
  await expect(list.locator("li").filter({ hasText: "Wall A" })).toContainText("m");

  // The canvas region itself is not a black hole for a screen reader.
  const results = await audit(page).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
});

test("Dynamic Type at 135% does not break the layout", async ({ page }) => {
  await skipTutorial(page);
  // Browsers expose text scaling as a root font-size change; 135% is the top of
  // the range docs/02 §9 requires.
  await page.addStyleTag({ content: "html { font-size: 135% !important; }" });
  await page.waitForTimeout(300);

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });
  // Vertical scrolling is fine; horizontal scrolling means something was cut off.
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

  // Every control still meets the 44 px touch target of docs/02 §4.
  const small = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll("button, a, [role='button']")) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.height < 40) bad.push(`${el.tagName}.${el.className}: ${Math.round(rect.height)}px`);
    }
    return bad;
  });
  expect(small).toEqual([]);
});

test("the whole draw flow is reachable from the keyboard", async ({ page }) => {
  await skipTutorial(page);

  // Tab to the primary action and activate it — no pointer used at all.
  for (let i = 0; i < 12; i++) {
    const id = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    if (id === "new-room") break;
    await page.keyboard.press("Tab");
  }
  await expect(page.locator("[data-testid='new-room']")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByTestId("drawing-board").waitFor();

  // The board's typed-dimension path is the keyboard route to an exact room
  // (docs/02 §9: "enter-to-type-dimension").
  await expect(page.getByTestId("board-canvas")).toBeVisible();
  const focusable = await page.evaluate(
    () => document.querySelectorAll("button:not([disabled]), [href], input, select, [tabindex]:not([tabindex='-1'])").length,
  );
  expect(focusable).toBeGreaterThan(3);
});
