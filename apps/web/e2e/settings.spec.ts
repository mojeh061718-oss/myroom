import { expect, test } from "@playwright/test";

/**
 * Configuring the reconstruction service from inside the app (docs/03 §8).
 *
 * This is a phone app: the person who installs it knows their endpoint and
 * cannot rebuild a PWA to tell it one. So the address is a field, it survives a
 * relaunch, and a wrong one says so before anybody shoots a room's worth of
 * photos.
 */
test("the reconstruction service is set up in the app, and remembered", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tutorial-skip").click();
  await expect(page.getByTestId("home")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  const link = page.getByTestId("service-link");
  await expect(link).toContainText("not set up");
  await link.click();

  await expect(page.getByTestId("settings")).toBeVisible();
  await page.getByTestId("service-url").fill("https://rooms.example.com/");
  await page.getByTestId("service-token").fill("hunter2");
  await page.getByTestId("service-save").click();
  await expect(page.getByTestId("service-probe-saved")).toBeVisible();

  // Survives a relaunch — a setting you retype every time is not a setting.
  await page.reload();
  await expect(page.getByTestId("service-url")).toHaveValue("https://rooms.example.com");
  await expect(page.getByTestId("service-token")).toHaveValue("hunter2");

  // And Home now reports it as configured.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("home")).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("service-link")).toContainText("connected");
});

test("an address that isn't there fails loudly rather than silently", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings")).toBeVisible({ timeout: 15_000 });

  // Empty is caught without a network round trip.
  await page.getByTestId("service-test").click();
  await expect(page.getByTestId("service-probe-fail")).toContainText("Enter an address first");

  await page.getByTestId("service-url").fill("http://127.0.0.1:9/nothing-listens-here");
  await page.getByTestId("service-test").click();
  await expect(page.getByTestId("service-probe-fail")).toBeVisible({ timeout: 20_000 });
});
