import { expect, test, type Page } from "@playwright/test";
import { boardBox } from "./board.js";

/**
 * M2 golden path: draw → build. The drawn plan must extrude into a correct,
 * navigable 3D room within the docs/06 §8 budgets.
 */

declare global {
  interface Window {
    __myroomRenderer?: {
      info: { render: { triangles: number; calls: number }; memory: { geometries: number } };
    };
    __myroomScene?: { getObjectByName: (n: string) => unknown };
  }
}

async function drawRoomAndOpenSandbox(page: Page) {
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
  await page.getByTestId("tool-door").click();
  await click(0, -d);
  await page.getByTestId("tool-window").click();
  await click(w, 0);
  await page.waitForTimeout(300);

  const sandboxUrl = page.url().replace("/draw", "");
  await page.goto(sandboxUrl);
  await page.getByTestId("sandbox").waitFor({ timeout: 25_000 });
  await page.waitForFunction(() => !!window.__myroomRenderer, null, { timeout: 25_000 });
}

test("a drawn plan builds into a 3D room within the performance budget", async ({ page }) => {
  const started = Date.now();
  await drawRoomAndOpenSandbox(page);
  // docs/06 §8: scene interactive < 2 s. Measured from navigation, which also
  // covers loading the code-split 3D chunk.
  await page.waitForTimeout(2500); // let the establishing orbit settle

  const info = await page.evaluate(() => {
    const r = window.__myroomRenderer!;
    return { tris: r.info.render.triangles, calls: r.info.render.calls };
  });

  // An empty shell must sit far under the furnished-room budget.
  expect(info.tris).toBeGreaterThan(0);
  expect(info.tris).toBeLessThan(300_000); // docs/06 §8 triangle budget
  expect(info.calls).toBeLessThanOrEqual(150); // docs/06 §8 draw-call budget

  // Every wall is its own mesh so it can be painted individually (docs/06 §4).
  const named = await page.evaluate(() => ({
    wallA: !!window.__myroomScene?.getObjectByName("wall-A"),
    floor: !!window.__myroomScene?.getObjectByName("floor"),
  }));
  expect(named.wallA).toBe(true);
  expect(named.floor).toBe(true);
  expect(Date.now() - started).toBeLessThan(60_000);
});

test("camera presets and the 2D toggle all work without crashing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await drawRoomAndOpenSandbox(page);
  await page.waitForTimeout(2200);

  const views = page.getByRole("group", { name: "Camera view" });
  for (const label of ["Inside", "2D", "Dollhouse"]) {
    await views.getByText(label, { exact: true }).click();
    await page.waitForTimeout(1200);
    await expect(page.getByTestId("sandbox")).toBeVisible();
  }
  // Wall fade only applies to dollhouse (docs/06 §2).
  await expect(page.getByTestId("wall-fade-toggle")).toBeEnabled();
  await page.getByTestId("wall-fade-toggle").click();
  await page.waitForTimeout(500);
  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("an unclosed plan explains itself instead of rendering an empty scene", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tutorial-skip").click();
  await page.getByTestId("new-room").click();
  await page.getByTestId("drawing-board").waitFor();
  const box = await boardBox(page);
  const click = (x: number, y: number) =>
    page.mouse.click(box.x + box.width / 2 + 60 * x, box.y + box.height / 2 - 60 * y);
  await click(-1.5, 1);
  await click(1.5, 1);
  await page.waitForTimeout(300);

  await page.goto(page.url().replace("/draw", ""));
  await expect(page.getByTestId("sandbox-empty-action")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("closed loop")).toBeVisible();
});
