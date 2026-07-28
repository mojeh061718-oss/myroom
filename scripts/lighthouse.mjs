#!/usr/bin/env node
/**
 * Lighthouse gate (docs/09 M6 acceptance: PWA ≥ 95 / Performance ≥ 85).
 *
 *   node scripts/lighthouse.mjs http://localhost:4180
 *
 * Runs against the built PWA, throttled to a mid-range mobile device — the
 * class of hardware the acceptance criterion names. Prints each category and
 * exits non-zero if a threshold is missed.
 *
 * `lighthouse` is not a repository dependency: it is a large tree that only
 * this check needs. Install it on demand:
 *   npm install --no-save lighthouse
 */
import { launch } from "chrome-launcher";
import lighthouse from "lighthouse";

const url = process.argv[2] ?? "http://localhost:4180";
const THRESHOLDS = { performance: 0.85, accessibility: 0.95, "best-practices": 0.9, seo: 0.9 };

const chrome = await launch({
  chromePath: process.env.PW_CHROMIUM_PATH || undefined,
  chromeFlags: [
    "--headless=new",
    "--no-sandbox",
    // No GPU on CI runners; the sandbox falls back to SwiftShader the same way
    // the E2E suite does.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});

try {
  const result = await lighthouse(
    url,
    { port: chrome.port, output: "json", logLevel: "error" },
    // Mobile is the default preset; naming it makes the target explicit.
    { extends: "lighthouse:default", settings: { formFactor: "mobile", screenEmulation: { mobile: true } } },
  );

  const scores = Object.fromEntries(
    Object.entries(result.lhr.categories).map(([key, category]) => [key, category.score]),
  );

  let failed = 0;
  for (const [category, score] of Object.entries(scores)) {
    const threshold = THRESHOLDS[category];
    const pct = score === null ? "n/a" : `${Math.round(score * 100)}`;
    const verdict = threshold === undefined ? "     " : score >= threshold ? "PASS " : "FAIL ";
    if (threshold !== undefined && (score === null || score < threshold)) failed++;
    console.log(`${verdict} ${category.padEnd(16)} ${pct.padStart(3)}${threshold ? ` (target ${Math.round(threshold * 100)})` : ""}`);
  }

  // Name what actually failed, so the number is actionable rather than a score.
  for (const [category, detail] of Object.entries(result.lhr.categories)) {
    if (THRESHOLDS[category] === undefined || detail.score >= THRESHOLDS[category]) continue;
    console.log(`\n${category} — failing audits:`);
    for (const ref of detail.auditRefs) {
      const audit = result.lhr.audits[ref.id];
      if (!audit || audit.score === null || audit.score === 1 || audit.scoreDisplayMode === "notApplicable") continue;
      console.log(`  - ${audit.id}: ${audit.title}`);
    }
  }

  // The PWA category was removed from Lighthouse 12; installability is checked
  // by the golden-path E2E instead (manifest + service worker are served).
  if (!("pwa" in scores)) {
    console.log("\nNote: this Lighthouse has no PWA category; installability is covered by e2e/golden-path.spec.ts.");
  }

  process.exit(failed > 0 ? 1 : 0);
} finally {
  await chrome.kill();
}
