import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// PWA per docs/03 §2: Workbox precache of the app shell; runtime caches for
// catalog assets (CacheFirst, LRU), API GETs (SWR), scene bundles (CacheFirst).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "My Room Sandbox",
        short_name: "My Room",
        description: "Your room. Reimagined.",
        start_url: "/",
        display: "standalone",
        background_color: "#0E0F12",
        theme_color: "#0E0F12",
        orientation: "any",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: /\/catalog\//,
            handler: "CacheFirst",
            options: {
              cacheName: "catalog-assets",
              expiration: { maxEntries: 2000, purgeOnQuotaError: true },
            },
          },
          {
            urlPattern: /\/v1\/.*$/,
            method: "GET",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "api-get" },
          },
          {
            urlPattern: /\/scenes\/.*$/,
            handler: "CacheFirst",
            options: {
              cacheName: "scene-bundles",
              expiration: { maxEntries: 200, purgeOnQuotaError: true },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      "/v1": "http://localhost:8787",
    },
  },
  test: {
    // Unit tests only — e2e/ belongs to Playwright, which has its own runner.
    include: ["src/**/*.test.ts?(x)"],
  },
});
