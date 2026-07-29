import * as THREE from "three";

/**
 * Procedural surface textures (docs/06 §4) — canvas-generated, so the floor
 * reads as planks or tile at true scale with zero downloads and nothing for
 * the service worker to precache. Each map is near-white and multiplied by
 * the material's colour, so one texture serves every swatch of its kind.
 *
 * Generated once per pattern and cached; repeat is set per room so a plank
 * is always ~12 cm wide however large the floor is.
 */

export type FloorPattern = "wood" | "tile" | "carpet" | "plain";

/** World-space size of one texture tile, metres. */
export const TILE_WORLD_M = 1.2;

const cache = new Map<string, { map: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture }>();

/** Deterministic PRNG so the grain never changes between visits. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  return [canvas, canvas.getContext("2d")!];
}

function drawWood(albedo: CanvasRenderingContext2D, rough: CanvasRenderingContext2D): void {
  const rand = mulberry32(41);
  albedo.fillStyle = "#f2ede6";
  albedo.fillRect(0, 0, 512, 512);
  rough.fillStyle = "#b4b4b4";
  rough.fillRect(0, 0, 512, 512);

  // Planks: TILE_WORLD_M covers 512 px, so a ~12 cm plank is 512/10 px.
  const plank = 512 / 10;
  for (let x = 0; x < 512; x += plank) {
    // Per-plank tonal variation, staggered end joints.
    const columnShift = Math.floor(rand() * 512);
    for (let y = -512; y < 1024; y += 512 * (0.4 + rand() * 0.5)) {
      const yy = y + columnShift;
      const tone = 0.9 + rand() * 0.14;
      albedo.fillStyle = `rgba(${Math.round(238 * tone)}, ${Math.round(230 * tone)}, ${Math.round(219 * tone)}, 1)`;
      albedo.fillRect(x + 1, yy, plank - 2, 512 * 0.9);
      // Grain streaks.
      albedo.strokeStyle = "rgba(120, 96, 72, 0.10)";
      albedo.lineWidth = 1;
      for (let g = 0; g < 6; g++) {
        const gx = x + 3 + rand() * (plank - 6);
        albedo.beginPath();
        albedo.moveTo(gx, yy);
        albedo.bezierCurveTo(gx + rand() * 4 - 2, yy + 128, gx + rand() * 4 - 2, yy + 256, gx, yy + 460);
        albedo.stroke();
      }
      // End joint shadow.
      albedo.fillStyle = "rgba(60, 45, 30, 0.28)";
      albedo.fillRect(x + 1, yy - 1, plank - 2, 2);
    }
    // Plank gap.
    albedo.fillStyle = "rgba(50, 38, 26, 0.35)";
    albedo.fillRect(x, 0, 1.5, 512);
    rough.fillStyle = "rgba(255,255,255,0.5)";
    rough.fillRect(x, 0, 1.5, 512);
  }
}

function drawTile(albedo: CanvasRenderingContext2D, rough: CanvasRenderingContext2D): void {
  const rand = mulberry32(97);
  albedo.fillStyle = "#efefed";
  albedo.fillRect(0, 0, 512, 512);
  rough.fillStyle = "#909090";
  rough.fillRect(0, 0, 512, 512);
  // 2 × 2 tiles per TILE_WORLD_M → 60 cm tiles.
  const tile = 256;
  for (let x = 0; x < 512; x += tile) {
    for (let y = 0; y < 512; y += tile) {
      const tone = 0.93 + rand() * 0.09;
      albedo.fillStyle = `rgba(${Math.round(235 * tone)}, ${Math.round(235 * tone)}, ${Math.round(233 * tone)}, 1)`;
      albedo.fillRect(x + 2, y + 2, tile - 4, tile - 4);
      // Faint mottle.
      for (let m = 0; m < 22; m++) {
        albedo.fillStyle = `rgba(150, 150, 148, ${0.03 + rand() * 0.04})`;
        albedo.beginPath();
        albedo.arc(x + rand() * tile, y + rand() * tile, 6 + rand() * 18, 0, Math.PI * 2);
        albedo.fill();
      }
    }
  }
  // Grout.
  albedo.strokeStyle = "rgba(90, 88, 84, 0.55)";
  albedo.lineWidth = 3;
  rough.strokeStyle = "rgba(255,255,255,0.7)";
  rough.lineWidth = 3;
  for (let t = 0; t <= 512; t += tile) {
    for (const ctx of [albedo, rough]) {
      ctx.beginPath();
      ctx.moveTo(t, 0);
      ctx.lineTo(t, 512);
      ctx.moveTo(0, t);
      ctx.lineTo(512, t);
      ctx.stroke();
    }
  }
}

function drawCarpet(albedo: CanvasRenderingContext2D, rough: CanvasRenderingContext2D): void {
  const rand = mulberry32(23);
  albedo.fillStyle = "#efece7";
  albedo.fillRect(0, 0, 512, 512);
  rough.fillStyle = "#e0e0e0"; // carpet is rough everywhere
  rough.fillRect(0, 0, 512, 512);
  // Fine speckle: pile.
  for (let i = 0; i < 26_000; i++) {
    const tone = 200 + Math.floor(rand() * 55);
    albedo.fillStyle = `rgba(${tone}, ${tone - 4}, ${tone - 10}, 0.35)`;
    albedo.fillRect(rand() * 512, rand() * 512, 1.5, 1.5);
  }
}

/** The cached texture pair for a pattern; "plain" returns null (flat colour). */
export function floorTextures(pattern: FloorPattern): { map: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } | null {
  if (pattern === "plain") return null;
  const hit = cache.get(pattern);
  if (hit) return hit;

  const [albedoCanvas, albedo] = makeCanvas();
  const [roughCanvas, rough] = makeCanvas();
  if (pattern === "wood") drawWood(albedo, rough);
  else if (pattern === "tile") drawTile(albedo, rough);
  else drawCarpet(albedo, rough);

  const map = new THREE.CanvasTexture(albedoCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  const pair = { map, roughnessMap };
  cache.set(pattern, pair);
  return pair;
}

/**
 * A subtle roughness variation for walls, so paint reads as a surface
 * rather than a fill colour. Near-constant — the variation is a whisper.
 */
export function wallRoughnessMap(): THREE.CanvasTexture {
  const cached = cache.get("wall-roughness");
  if (cached) return cached.roughnessMap;
  const rand = mulberry32(7);
  const [canvas, ctx] = makeCanvas();
  ctx.fillStyle = "#ebebeb";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 240; i++) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.02 + rand() * 0.05})`;
    ctx.beginPath();
    ctx.arc(rand() * 512, rand() * 512, 14 + rand() * 46, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  cache.set("wall-roughness", { map: texture, roughnessMap: texture });
  return texture;
}
