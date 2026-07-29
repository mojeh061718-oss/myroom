import { expect, test } from "@playwright/test";

/**
 * Where reconstruction runs, checked in a real browser (docs/05 §10 revisited).
 *
 * docs/05 §10 deferred on-device reconstruction until "WebGPU inference
 * matures". It has — WebGPU is enabled by default in Safari on iOS 26, backed
 * by Metal — so the pipeline now picks a tier per device rather than assuming a
 * server with an NVIDIA card. This suite pins the two properties that matter:
 *
 *   1. Whatever tier a device lands on, the pipeline is available. There is no
 *      "your device is unsupported" outcome.
 *   2. What we tell the user about their photos matches the tier we actually
 *      chose. A local tier may not claim uploads; a server tier may not claim
 *      the photos stayed put.
 *
 * The CI runner is headless Chromium on SwiftShader, so it may report either
 * `webgpu` or `wasm` depending on the build. Both are correct answers — the
 * test asserts coherence, not a particular tier, because pinning the tier would
 * make this pass or fail on a detail of the runner rather than on our code.
 */

const LOCAL_TIERS = ["webgpu", "wasm"];

test("the privacy screen names the tier this device actually uses", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tutorial-skip").click();

  await page.goto("/privacy");
  await expect(page.getByTestId("privacy")).toBeVisible();

  const sentence = page.getByTestId("privacy-tier-sentence");
  await expect(sentence).toBeVisible();

  // The probe is async; it must resolve to a real tier, not sit on "detecting".
  await expect(sentence).not.toHaveAttribute("data-tier", "detecting", { timeout: 15_000 });

  const tier = await sentence.getAttribute("data-tier");
  expect(["webgpu", "wasm", "server"]).toContain(tier);

  const text = (await sentence.textContent())?.trim() ?? "";
  expect(text.length).toBeGreaterThan(10);

  // Property 2: the promise has to match the tier.
  if (LOCAL_TIERS.includes(tier!)) {
    expect(text).toContain("never leave");
    expect(text).not.toContain("uploaded");
  } else {
    expect(text).toContain("uploaded");
  }
});

test("no device is told its browser is unsupported", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tutorial-skip").click();

  await page.goto("/privacy");
  const sentence = page.getByTestId("privacy-tier-sentence");
  await expect(sentence).not.toHaveAttribute("data-tier", "detecting", { timeout: 15_000 });

  const tier = await sentence.getAttribute("data-tier");
  expect(["webgpu", "wasm", "server"]).toContain(tier);

  // The reconstruct entry point must be reachable whatever the tier — the
  // failure this guards against is a device being told it cannot build a room.
  const text = (await sentence.textContent())?.trim() ?? "";
  expect(text).not.toMatch(/unsupported|not supported|cannot|unavailable/i);
});

test("WebGPU detection does not throw on a browser that lacks it", async ({ page }) => {
  // Simulate an older browser by removing navigator.gpu before any app code runs.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  });

  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tutorial-skip").click();

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/privacy");
  const sentence = page.getByTestId("privacy-tier-sentence");
  await expect(sentence).not.toHaveAttribute("data-tier", "detecting", { timeout: 15_000 });

  // Falling back is the required behaviour — never an exception, never "server"
  // purely because WebGPU is missing while the CPU is right there.
  const tier = await sentence.getAttribute("data-tier");
  expect(tier).toBe("wasm");
  expect(errors).toEqual([]);
});
