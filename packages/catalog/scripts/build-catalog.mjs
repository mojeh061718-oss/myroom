#!/usr/bin/env node
/**
 * CC0 catalog asset pipeline (docs/08 §5, docs/07 §5).
 *
 * Fetches CC0 models from Poly Haven, maps each to a category in our taxonomy,
 * bundles glTF + textures into a single optimized GLB, and emits the
 * CatalogItem manifest with `license` and `source` recorded per item.
 *
 * Budgets enforced here (docs/06 §8, docs/07 §5):
 *   - ≤ 15 000 triangles per model (anything larger is rejected, not shipped)
 *   - textures resized down, Draco mesh compression applied
 *
 * Usage:
 *   node scripts/build-catalog.mjs [--limit N] [--out DIR]
 *
 * Only CC0 assets are accepted. Anything reporting another licence is skipped
 * loudly — CC-BY attribution obligations don't survive our redistribution
 * model (docs/08 §5).
 */
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO, getBounds } from "@gltf-transform/core";
import { KHRDracoMeshCompression, ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, weld, draco, resample, simplify, textureCompress } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import draco3d from "draco3dgltf";
import sharp from "sharp";
import { OBJECT_CATEGORIES } from "../src/taxonomy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
// No cap by default; this used to be 40. Removing it changed nothing on its
// own — of Poly Haven's 521 published models only 107 match a category here,
// because `matchCategory` reads the id and name and deliberately ignores the
// broad tags. The catalog is small because Poly Haven is mostly props and
// decor, not because the ingest stopped early. Models matching no category are
// skipped before any download, so an uncapped run costs only what it ingests.
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) || Infinity : Infinity;
// Models are written straight into the web app's served static dir; only the
// manifest lives in this package, so the GLBs aren't stored twice in the repo.
const outDir = args.includes("--out")
  ? args[args.indexOf("--out") + 1]
  : join(here, "../../../apps/web/public/catalog");
const manifestDir = join(here, "../assets");
const API = "https://api.polyhaven.com";
const MAX_TRIS = 15000;

/**
 * Poly Haven asset id / name / tags → one of our taxonomy categories.
 * Matching is deliberately conservative: an asset we can't confidently place
 * is skipped rather than filed under the wrong category, which would poison
 * the M4 catalog-match step.
 */
function matchCategory(asset, id) {
  // Match on the asset's id and name only. Poly Haven tags are broad
  // ("industrial", "containers", "drum") and produced confidently wrong
  // matches — a barrel filed as a drum kit. camelCase is split so
  // "CoffeeTable_01" reads as "coffee table 01".
  const words = (text) =>
    String(text)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_\-]+/g, " ")
      .toLowerCase();
  const haystack = ` ${words(id)} ${words(asset.name ?? "")} `;

  // Every category whose label or a synonym appears as a whole word. Longest
  // needle first, so "coffee table" outranks "table".
  const hits = [];
  for (const category of OBJECT_CATEGORIES) {
    const needles = [category.label.toLowerCase(), ...category.detectionPrompts]
      .filter((n) => n.length >= 4)
      .sort((a, b) => b.length - a.length);
    for (const needle of needles) {
      // Whole-word match, so "bench" can't be found inside "workbenches".
      if (haystack.includes(` ${needle} `)) {
        hits.push({ category, needleLength: needle.length });
        break;
      }
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.needleLength - a.needleLength);
  return hits;
}

/**
 * Pick between categories that all matched by name, using the model's measured
 * size. "Shelf_01" matches both Floating Shelf and Bookshelf; at 2.08 m tall it
 * is plainly the latter.
 */
function disambiguate(hits, size) {
  const best = hits[0];
  const topLength = best.needleLength;
  const tied = hits.filter((h) => h.needleLength === topLength);
  if (tied.length === 1) return best.category;

  const score = (c) =>
    Math.abs(Math.log(c.defaultSize.w / size.w)) +
    Math.abs(Math.log(c.defaultSize.h / size.h)) +
    Math.abs(Math.log(c.defaultSize.d / size.d));
  return tied.reduce((a, b) => (score(b.category) < score(a.category) ? b : a)).category;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.length;
}

function triangleCount(document) {
  let tris = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      tris += indices ? indices.getCount() / 3 : (prim.getAttribute("POSITION")?.getCount() ?? 0) / 3;
    }
  }
  return Math.round(tris);
}

/**
 * Real-world size in metres from the scene's *world-space* bounding box.
 * Reading raw POSITION accessors ignores node scale, which reported one
 * shelving unit as 21 m tall.
 */
function nativeSize(document) {
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) return null;
  const { min, max } = getBounds(scene);
  if (!Number.isFinite(min[0]) || !Number.isFinite(max[0])) return null;
  // glTF is Y-up, metres: X→width, Y→height, Z→depth.
  return {
    w: Math.round((max[0] - min[0]) * 1000) / 1000,
    h: Math.round((max[1] - min[1]) * 1000) / 1000,
    d: Math.round((max[2] - min[2]) * 1000) / 1000,
  };
}

/** Furniture-scale sanity gate: nothing in a room is 6 m across. */
function plausibleSize(size) {
  const dims = [size.w, size.h, size.d];
  return dims.every((v) => v > 0.02 && v < 6);
}

async function main() {
  console.log("Fetching Poly Haven model index…");
  const index = await fetchJson(`${API}/assets?type=models`);
  const entries = Object.entries(index);
  console.log(`  ${entries.length} models published`);

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "draco3d.encoder": await draco3d.createEncoderModule(),
      "draco3d.decoder": await draco3d.createDecoderModule(),
    });

  const tmp = join(outDir, ".work");
  await mkdir(join(outDir, "models"), { recursive: true });

  const manifest = [];
  const skipped = [];
  const decimated = [];
  let processed = 0;

  for (const [id, asset] of entries) {
    if (processed >= limit) break;

    // docs/08 §5: CC0 only. Poly Haven reports 0 for CC0.
    if (asset.license !== undefined && asset.license !== "CC0") {
      skipped.push({ id, why: `licence ${asset.license}` });
      continue;
    }

    const hits = matchCategory(asset, id);
    if (!hits) continue;

    try {
      const files = await fetchJson(`${API}/files/${id}`);
      const gltfEntry = files?.gltf?.["1k"]?.gltf;
      if (!gltfEntry?.url) {
        skipped.push({ id, why: "no 1k gltf" });
        continue;
      }

      const work = join(tmp, id);
      await rm(work, { recursive: true, force: true });
      const gltfPath = join(work, `${id}.gltf`);
      await download(gltfEntry.url, gltfPath);

      // Fetch every dependency the API lists (bin + textures).
      const includes = gltfEntry.include ?? {};
      for (const [relPath, info] of Object.entries(includes)) {
        if (!info?.url) continue;
        await download(info.url, join(work, relPath));
      }

      const document = await io.read(gltfPath);

      const size = nativeSize(document);
      if (!size || size.w <= 0 || size.h <= 0) {
        skipped.push({ id, why: "no geometry" });
        continue;
      }
      if (!plausibleSize(size)) {
        skipped.push({ id, why: `implausible size ${size.w}×${size.d}×${size.h} m` });
        await rm(work, { recursive: true, force: true });
        continue;
      }
      const category = disambiguate(hits, size);

      await document.transform(
        dedup(),
        weld(),
        resample(),
        prune(),
        // Textures down to 512 keeps the whole catalog inside the docs/06 §8
        // 256 MB texture budget with room to spare.
        textureCompress({ encoder: sharp, resize: [512, 512], targetFormat: "webp" }),
        draco(),
      );
      document.createExtension(KHRDracoMeshCompression).setRequired(true);

      let tris = triangleCount(document);
      if (tris > MAX_TRIS) {
        // Over budget is a reason to decimate, not to drop the model. The
        // rejects here are real furniture — dining chairs, drawer cabinets,
        // ceiling fans — and the catalog has no substitute for them: 151 of
        // 187 categories have no model at all, so every rejection becomes a
        // parametric placeholder in someone's room.
        //
        // Simplify to the budget with a tight error bound and re-measure. A
        // model that still will not fit is genuinely too dense to ship and is
        // skipped as before.
        try {
          await document.transform(
            weld(),
            simplify({ simplifier: MeshoptSimplifier, ratio: MAX_TRIS / tris, error: 0.005 }),
            draco(),
          );
          const after = triangleCount(document);
          if (after <= MAX_TRIS) {
            decimated.push({ id, from: tris, to: after });
            tris = after;
          }
        } catch (error) {
          skipped.push({ id, why: `${tris} tris, simplify failed: ${error.message}` });
          await rm(work, { recursive: true, force: true });
          continue;
        }
      }
      if (tris > MAX_TRIS) {
        skipped.push({ id, why: `${tris} tris over budget even after simplify` });
        await rm(work, { recursive: true, force: true });
        continue;
      }

      const glb = await io.writeBinary(document);
      const relGlb = `models/${id}.glb`;
      await writeFile(join(outDir, relGlb), glb);
      await rm(work, { recursive: true, force: true });

      manifest.push({
        id: `${category.id}/${id.toLowerCase()}`,
        category: category.id,
        name: asset.name ?? id,
        asset: { glb: `catalog/${relGlb}`, tris },
        nativeSize: size,
        scaleBounds: { min: 0.8, max: 1.25, nonUniform: true },
        materialSlots: category.materialSlots,
        faceSlot: category.faceSlot,
        support: category.support,
        embedding: null,
        license: "CC0",
        source: `https://polyhaven.com/a/${id}`,
        attribution: asset.authors ? Object.keys(asset.authors).join(", ") : undefined,
      });
      processed++;
      console.log(
        `  ✓ ${id} → ${category.id} (${tris} tris, ${(glb.byteLength / 1024).toFixed(0)} kB, ` +
          `${size.w}×${size.d}×${size.h} m)`,
      );
    } catch (error) {
      skipped.push({ id, why: String(error).slice(0, 80) });
    }
  }

  await rm(tmp, { recursive: true, force: true });
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\n${manifest.length} models in the catalog.`);
  if (skipped.length) {
    console.log(`${skipped.length} skipped:`);
    for (const s of skipped.slice(0, 12)) console.log(`   - ${s.id}: ${s.why}`);
  }
  console.log(`Manifest: ${join(manifestDir, "manifest.json")}`);
}

await main();
