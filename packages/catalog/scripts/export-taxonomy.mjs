#!/usr/bin/env node
/**
 * Export the object taxonomy as JSON for the Python workers.
 *
 * The detection vocabulary (docs/05 §3) and the app's placeable categories must
 * be the same set — a detector that can name "ottoman" while the app has no
 * ottoman to place produces an object nobody can edit. Generating the worker's
 * prompt list from this file makes that impossible to drift.
 *
 *   node scripts/export-taxonomy.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OBJECT_CATEGORIES } from "../src/taxonomy.ts";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "../assets");
await mkdir(outDir, { recursive: true });
const out = join(outDir, "taxonomy.json");
await writeFile(out, JSON.stringify(OBJECT_CATEGORIES, null, 2) + "\n");
console.log(`${OBJECT_CATEGORIES.length} categories → ${out}`);
