#!/usr/bin/env node
/**
 * CI license gate (docs/08 §7).
 *
 * Runtime dependencies must be MIT / Apache-2.0 / BSD / ISC (or CC0 for
 * assets). Anything outside the allowlist fails the build and requires an
 * explicit, documented exemption in docs/08-open-source-stack.md.
 *
 * The policy itself lives in ./license-policy.mjs and is unit-tested.
 *
 * Usage: node scripts/check-licenses.mjs
 */
import { execFileSync } from "node:child_process";
import { EXEMPTIONS, isAllowed } from "./license-policy.mjs";

function readProductionLicenses() {
  // `--prod` scopes the report to runtime dependencies, which is exactly the
  // scope of the policy; dev-only tooling is never shipped to users.
  const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json", "-r"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

let report;
try {
  report = readProductionLicenses();
} catch (error) {
  console.error("Could not read the dependency license report.");
  console.error(error.stderr?.toString() ?? error.message);
  process.exit(1);
}

const violations = [];
let checked = 0;

for (const [license, packages] of Object.entries(report)) {
  for (const pkg of packages) {
    checked++;
    const name = pkg.name ?? "(unknown)";
    if (EXEMPTIONS.has(name)) continue;
    if (!isAllowed(license)) {
      violations.push({ name, version: pkg.versions?.join(", ") ?? "", license });
    }
  }
}

if (violations.length > 0) {
  console.error(`License gate FAILED — ${violations.length} runtime dependencies outside the allowlist:\n`);
  for (const v of violations) {
    console.error(`  ✗ ${v.name}@${v.version} — ${v.license}`);
  }
  console.error("\nPolicy (docs/08 §7): runtime dependencies must be MIT / Apache-2.0 / BSD / ISC / CC0.");
  console.error("Replace the dependency, or add a documented exemption to docs/08-open-source-stack.md.");
  process.exit(1);
}

console.log(`License gate passed — ${checked} runtime dependencies, all within the allowlist.`);
