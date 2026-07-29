import { defineConfig, devices } from "@playwright/test";

/**
 * Golden-path E2E (docs/09 cross-milestone rule 1). Runs against the built PWA
 * (vite preview) so the manifest and service worker are real.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  /**
   * One worker in CI. Every 3D test drives a software WebGL context, and two of
   * them on a two-core runner thrash badly enough that tests start timing out
   * rather than merely running slowly — a two-project run took 40 minutes and
   * failed 16 tests locally, and each project alone took three minutes and
   * passed. Serial is faster here than parallel.
   */
  workers: process.env.CI ? 1 : undefined,
  /** A hung suite should fail in half an hour, not burn a runner for two. */
  globalTimeout: process.env.CI ? 30 * 60_000 : undefined,
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    // Pre-provisioned Chromium (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD environments);
    // empty string falls back to Playwright's own download elsewhere.
    launchOptions: {
      ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
      // The 3D sandbox needs a WebGL context; CI runners have no GPU, so fall
      // back to SwiftShader's software renderer.
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    command: "pnpm run build && pnpm exec vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
