import * as THREE from "three";
import Anthropic from "@anthropic-ai/sdk";
import type { ScanSeedObject } from "@myroom/recon";
import { OBJECT_CATEGORIES } from "@myroom/catalog";

/**
 * AI naming for scanned objects (docs/05 §6's "what is this?" question,
 * answered): render a small crop of the scan around each detected cluster,
 * send the crops in ONE request to the Anthropic API with the taxonomy, and
 * get back a category id per cluster.
 *
 * Strictly optional and strictly local-first: this runs only when the user
 * pasted their own API key into Settings, the key never leaves the device
 * except to api.anthropic.com, and a failure of any kind falls back to the
 * unnamed "Scanned item" boxes. Geometry-only guessing stays the default.
 */

const MODEL = "claude-opus-5";
export const MAX_NAMED_SEEDS = 14;
const CROP_PX = 224;
const GRID_COLS = 4;

interface NameInput {
  apiKey: string;
  /** the seeds, in the SCAN's own frame (matching the mesh coordinates) */
  scanSeeds: readonly ScanSeedObject[];
  /** decoded scan geometry, scan frame, world Y-up; indices empty = point cloud */
  scanMesh: { positions: Float32Array; indices: Uint32Array };
  /** optional room photos — far better evidence than normal-shaded crops */
  photos?: readonly Blob[];
}

export interface MissedItem {
  category: string;
  size: { w: number; d: number; h: number };
}

/**
 * Returns a taxonomy category id (or null) per seed, index-aligned with
 * `scanSeeds`, plus items visible in the photos that the scan missed.
 * Never throws — a network/API/render failure returns all nulls plus a note
 * explaining why.
 */
export async function nameScannedObjects({ apiKey, scanSeeds, scanMesh, photos = [] }: NameInput): Promise<{
  categories: (string | null)[];
  missing: MissedItem[];
  note: string | null;
}> {
  const none: (string | null)[] = scanSeeds.map(() => null);
  const targets = scanSeeds.slice(0, MAX_NAMED_SEEDS);
  if (targets.length === 0) return { categories: [], missing: [], note: null };

  let grid: string;
  try {
    grid = renderCropGrid(scanMesh, targets);
  } catch (error) {
    return {
      categories: none,
      missing: [],
      note: `AI naming skipped — couldn't render the scan (${(error as Error).message}).`,
    };
  }

  // Room photos, downscaled and re-encoded (phones shoot HEIC; the API wants
  // JPEG). A photo that won't decode is skipped, never fatal.
  const photoImages: string[] = [];
  for (const photo of photos.slice(0, 2)) {
    try {
      photoImages.push(await blobToJpeg(photo));
    } catch {
      // undecodable format — the crops alone still work
    }
  }

  const ids = OBJECT_CATEGORIES.map((c) => c.id);
  const schema = {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            category: { anyOf: [{ type: "string", enum: ids }, { type: "null" }] },
          },
          required: ["index", "category"],
          additionalProperties: false,
        },
      },
      missing: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: ids },
            width: { type: "number" },
            depth: { type: "number" },
            height: { type: "number" },
          },
          required: ["category", "width", "depth", "height"],
          additionalProperties: false,
        },
      },
    },
    required: ["assignments", "missing"],
    additionalProperties: false,
  } as const;

  const sizes = targets
    .map(
      (s, i) =>
        `#${i}: ${s.size.w.toFixed(2)} m wide × ${s.size.d.toFixed(2)} m deep × ${s.size.h.toFixed(2)} m tall, base ${s.position.y.toFixed(2)} m above the floor`,
    )
    .join("\n");

  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const content: ({ type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } } | { type: "text"; text: string })[] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: grid },
      },
    ];
    for (const data of photoImages) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    }
    content.push({
      type: "text",
      text:
        `The first image is a grid of ${targets.length} numbered crops from a rough 3D LiDAR scan of a home interior, rendered with normal-direction shading (colours indicate surface orientation, not material). Each crop shows one detected object cluster, viewed from a high three-quarter angle; surrounding geometry is clipped away. The measured real-world size of each is:\n${sizes}\n\n` +
        (photoImages.length > 0
          ? `The ${photoImages.length === 1 ? "next image is a photo" : `next ${photoImages.length} images are photos`} of the same room — far clearer evidence of what each object is. Use the photos to identify the crops.\n\n`
          : "") +
        `For each crop, identify the household object. Choose the single best-fitting category id from this list, or null when you genuinely can't tell:\n${ids.join(", ")}\n\n` +
        `Size is strong evidence — a 1.8 m wide, 0.9 m deep, 0.8 m tall block against a wall is far more likely a sofa than a bathtub. Answer for every index from 0 to ${targets.length - 1}.` +
        (photoImages.length > 0
          ? `\n\nThen list under "missing" the significant furniture you can SEE in the photos that is clearly NOT among the ${targets.length} detected objects — at most 8, each with its taxonomy category and approximate real-world size in metres. Only include things a person would want in a floor plan (furniture and appliances, not decor, toys or clutter), and leave the list empty when everything visible is already detected.`
          : ""),
    });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2500,
      output_config: { effort: "low", format: { type: "json_schema", schema: schema as unknown as Record<string, unknown> } },
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return { categories: none, missing: [], note: "AI naming was declined by the API — kept the measured boxes unnamed." };
    }
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    const parsed = JSON.parse(text) as {
      assignments: { index: number; category: string | null }[];
      missing?: { category: string; width: number; depth: number; height: number }[];
    };
    const categories = [...none];
    const valid = new Set(ids);
    for (const a of parsed.assignments ?? []) {
      if (a.index >= 0 && a.index < targets.length && (a.category === null || valid.has(a.category))) {
        categories[a.index] = a.category;
      }
    }
    const clamp = (n: number) => Math.min(3, Math.max(0.1, Number.isFinite(n) ? n : 0.5));
    const missing: MissedItem[] = (parsed.missing ?? [])
      .filter((m) => valid.has(m.category))
      .slice(0, 8)
      .map((m) => ({ category: m.category, size: { w: clamp(m.width), d: clamp(m.depth), h: clamp(m.height) } }));
    const named = categories.filter((c) => c !== null).length;
    return {
      categories,
      missing,
      note:
        named > 0
          ? `AI named ${named} of ${targets.length} scanned object${targets.length === 1 ? "" : "s"} — check the list and untick anything wrong.`
          : "AI couldn't confidently name the scanned objects — they stay as measured boxes.",
    };
  } catch (error) {
    return { categories: none, missing: [], note: `AI naming failed (${(error as Error).message}) — kept the measured boxes.` };
  }
}

/** Downscale + re-encode any decodable image blob as base64 JPEG. */
async function blobToJpeg(blob: Blob, maxEdge = 1280): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/** Render one clipped crop per seed into a labelled JPEG grid; returns base64. */
function renderCropGrid(
  mesh: { positions: Float32Array; indices: Uint32Array },
  seeds: readonly ScanSeedObject[],
): string {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(CROP_PX, CROP_PX);
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#1a1c20");

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  const isMesh = mesh.indices.length >= 3;
  let object: THREE.Object3D;
  let material: THREE.Material;
  if (isMesh) {
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geometry.computeVertexNormals();
    material = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    object = new THREE.Mesh(geometry, material);
  } else {
    material = new THREE.PointsMaterial({ color: 0xd8c9a8, size: 0.03 });
    object = new THREE.Points(geometry, material);
  }
  scene.add(object);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);

  const rows = Math.ceil(seeds.length / GRID_COLS);
  const grid = document.createElement("canvas");
  grid.width = GRID_COLS * CROP_PX;
  grid.height = rows * CROP_PX;
  const ctx = grid.getContext("2d")!;
  ctx.fillStyle = "#101014";
  ctx.fillRect(0, 0, grid.width, grid.height);

  try {
    seeds.forEach((seed, i) => {
      // position.y is the box BASE; centre the crop on the volume.
      const cx = seed.position.x;
      const cy = seed.position.y + seed.size.h / 2;
      const cz = seed.position.z;
      const half = {
        x: Math.hypot(seed.size.w, seed.size.d) / 2 + 0.08,
        y: seed.size.h / 2 + 0.08,
        z: Math.hypot(seed.size.w, seed.size.d) / 2 + 0.08,
      };
      // Clip everything outside the seed's (axis-aligned, slightly padded) box
      // so the crop shows this object and not the room around it.
      material.clippingPlanes = [
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -(cx - half.x)),
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), cx + half.x),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -(cy - half.y)),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), cy + half.y),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -(cz - half.z)),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), cz + half.z),
      ];

      const span = Math.max(seed.size.w, seed.size.d, seed.size.h, 0.3);
      camera.position.set(cx + span * 1.15, cy + span * 0.9, cz + span * 1.15);
      camera.lookAt(cx, cy, cz);
      renderer.render(scene, camera);

      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      ctx.drawImage(renderer.domElement, col * CROP_PX, row * CROP_PX);
      // Index label, unmissable.
      ctx.font = "bold 30px sans-serif";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "#000";
      ctx.fillStyle = "#fff";
      const label = `#${i}`;
      ctx.strokeText(label, col * CROP_PX + 8, row * CROP_PX + 34);
      ctx.fillText(label, col * CROP_PX + 8, row * CROP_PX + 34);
    });
  } finally {
    geometry.dispose();
    material.dispose();
    renderer.dispose();
  }

  const dataUrl = grid.toDataURL("image/jpeg", 0.75);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}
