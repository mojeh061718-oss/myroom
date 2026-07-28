/**
 * Rasterizes public/icons/icon.svg into the PNG set the manifest references.
 * Run once (and after icon changes): node scripts/gen-icons.mjs
 * Generated PNGs are committed so builds don't depend on sharp.
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, "..", "public", "icons");
const svg = readFileSync(join(iconsDir, "icon.svg"));

const jobs = [
  { out: "icon-192.png", size: 192 },
  { out: "icon-512.png", size: 512 },
  { out: "apple-touch-icon.png", size: 180 },
];

for (const { out, size } of jobs) {
  await sharp(svg).resize(size, size).png().toFile(join(iconsDir, out));
  console.log(`wrote ${out}`);
}

// Maskable variant: same mark centered in a full-bleed 80% safe zone.
for (const size of [192, 512]) {
  const inner = Math.round(size * 0.8);
  const pad = Math.round((size - inner) / 2);
  await sharp(svg)
    .resize(inner, inner)
    .extend({ top: pad, bottom: size - inner - pad, left: pad, right: size - inner - pad, background: "#0E0F12" })
    .flatten({ background: "#0E0F12" })
    .png()
    .toFile(join(iconsDir, `icon-maskable-${size}.png`));
  console.log(`wrote icon-maskable-${size}.png`);
}
