/**
 * Records the M1 demo (docs/09 cross-milestone rule 4: "no milestone ships
 * silently — each ends with a tagged release, a changelog, and a demo recording
 * against the acceptance criteria").
 *
 * Walks the docs/04 §7 first-time-user criterion end to end on a phone-sized
 * viewport: draw a closed 4-wall room, correct one wall to an exact typed
 * length, add a door and a window, then proceed.
 *
 * Usage (with the app served at $BASE_URL, default http://localhost:4173):
 *   node scripts/record-m1-demo.mjs
 * Output: docs/demos/m1/*.webm + stills.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../../docs/demos/m1");
const baseURL = process.env.BASE_URL ?? "http://localhost:4173";
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({
  viewport: { width: 430, height: 900 },
  deviceScaleFactor: 2,
  recordVideo: { dir: outDir, size: { width: 430, height: 900 } },
});
const page = await context.newPage();
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) });
const pause = (ms = 700) => page.waitForTimeout(ms);

await page.goto(baseURL);
await pause(900);
await shot("01-splash");

// Tutorial is skippable at every step, and lands on Home in one tap (docs/01 §3).
await page.getByTestId("tutorial").waitFor();
await pause(1200);
await shot("02-tutorial");
await page.getByTestId("tutorial-skip").click();
await page.getByTestId("home").waitFor();
await pause();
await shot("03-home-empty");

await page.getByTestId("new-room").click();
await page.getByTestId("drawing-board").waitFor();
await pause();

const box = await page.getByTestId("board-canvas").boundingBox();
const at = (x, y) => [box.x + box.width / 2 + 60 * x, box.y + box.height / 2 - 60 * y];
const tap = async (x, y) => {
  const [px, py] = at(x, y);
  await page.mouse.move(px, py, { steps: 12 });
  await page.mouse.click(px, py);
  await pause(450);
};

// Draw a closed four-wall room.
await tap(-1.6, 1.2);
await tap(1.6, 1.2);
await tap(1.6, -1.2);
await tap(-1.6, -1.2);
await shot("04-drawing");
await tap(-1.6, 1.2); // closure snap
await pause();
await shot("05-height-sheet");
await page.getByTestId("height-2.44").click();
await pause();

// Correct one wall to an exact typed length.
await page.getByTestId("dim-label-A").click();
await pause(400);
await page.getByTestId("dimension-input").fill("4.25");
await shot("06-typed-dimension");
await page.getByTestId("dimension-input").press("Enter");
await pause();

// Add a door and a window.
await page.getByTestId("tool-door").click();
await tap(0, -1.2);
await page.getByTestId("tool-window").click();
await tap(1.6, 0);
await page.getByTestId("tool-select").click();
await pause();
await shot("07-openings");

// Undo / redo covers every mutation (docs/04 §7).
await page.getByTestId("undo").click();
await pause(500);
await page.getByTestId("redo").click();
await pause();

// Imperial toggle, then proceed.
await page.getByRole("group", { name: "Measurement units" }).getByText("ft").click();
await pause();
await shot("08-imperial");
await page.getByRole("group", { name: "Measurement units" }).getByText("m").click();
await pause();
await page.getByTestId("next-button").click();
await pause(1200);
await shot("09-next");

await context.close();
await browser.close();

// Give the recording a stable filename.
for (const file of readdirSync(outDir)) {
  if (file.endsWith(".webm") && file !== "m1-golden-path.webm") {
    renameSync(join(outDir, file), join(outDir, "m1-golden-path.webm"));
  }
}
console.log(`M1 demo written to ${outDir}`);
