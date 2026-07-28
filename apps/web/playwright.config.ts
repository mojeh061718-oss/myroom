import { defineConfig, devices } from "@playwright/test";

/**
 * Golden-path E2E (docs/09 cross-milestone rule 1). Runs against the built PWA
 * (vite preview) so the manifest and service worker are real.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
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
