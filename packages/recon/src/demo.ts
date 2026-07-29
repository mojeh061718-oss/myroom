import type { ShellGeometry } from "@myroom/geometry";
import { getCategory } from "@myroom/catalog";
import type { MeasuredObject } from "@myroom/schema";

/**
 * Deterministic stand-in for stages 1–3 (detect → solve → measure).
 *
 * This is a **fixture generator, not a detector**. It never looks at a photo:
 * it lays out a typical room from the shell geometry so the golden path
 * (draw → reconstruct → edit) can be exercised without a GPU, exactly as
 * docs/03 §8 specifies for CI ("draw → mock-reconstruct → edit").
 *
 * Anything that renders these objects to a user MUST label them as examples.
 * Presenting them as "what we found in your photos" would be a lie about the
 * user's own room; see DECISIONS.md → "Demo reconstruction is labelled".
 */

interface DemoSpec {
  category: string;
  /** which wall to hug: 0 = longest, 1 = second longest, … ; null = room centre */
  wallRank: number | null;
  /** fraction along that wall */
  along: number;
  size: { w: number; d: number; h: number };
  support: "floor" | "wall" | "ceiling";
  palette: string;
}

const LAYOUT: DemoSpec[] = [
  { category: "sofa", wallRank: 0, along: 0.5, size: { w: 2.1, d: 0.92, h: 0.84 }, support: "floor", palette: "#7C8B7A" },
  { category: "coffee-table", wallRank: null, along: 0.5, size: { w: 1.1, d: 0.6, h: 0.42 }, support: "floor", palette: "#8A6A48" },
  { category: "rug", wallRank: null, along: 0.5, size: { w: 2.4, d: 1.7, h: 0.02 }, support: "floor", palette: "#B8A48C" },
  { category: "media-console", wallRank: 1, along: 0.5, size: { w: 1.4, d: 0.4, h: 0.5 }, support: "floor", palette: "#4A4744" },
  { category: "tv", wallRank: 1, along: 0.5, size: { w: 1.2, d: 0.07, h: 0.7 }, support: "wall", palette: "#1B1B1D" },
  { category: "floor-lamp", wallRank: 0, along: 0.12, size: { w: 0.36, d: 0.36, h: 1.55 }, support: "floor", palette: "#C9C2B4" },
  { category: "armchair", wallRank: 2, along: 0.7, size: { w: 0.82, d: 0.86, h: 0.9 }, support: "floor", palette: "#8B7F72" },
  { category: "bookshelf", wallRank: 2, along: 0.25, size: { w: 0.9, d: 0.32, h: 1.9 }, support: "floor", palette: "#9C8365" },
  { category: "framed-picture", wallRank: 0, along: 0.5, size: { w: 0.6, d: 0.04, h: 0.8 }, support: "wall", palette: "#D8D2C6" },
  { category: "potted-plant", wallRank: 3, along: 0.85, size: { w: 0.45, d: 0.45, h: 1.1 }, support: "floor", palette: "#4F6B3C" },
];

export interface DemoOptions {
  /** how many pieces to lay out; the list is ordered most-typical first */
  count?: number;
  photoIds?: string[];
  newId: () => string;
}

export function demoMeasuredObjects(shell: ShellGeometry, opts: DemoOptions): MeasuredObject[] {
  const photoIds = opts.photoIds?.length ? opts.photoIds : ["demo-photo"];
  const byLength = [...shell.walls].sort((a, b) => b.length - a.length);
  const out: MeasuredObject[] = [];

  for (const spec of LAYOUT.slice(0, opts.count ?? LAYOUT.length)) {
    const category = getCategory(spec.category);
    if (!category) continue;

    let x: number;
    let z: number;
    let rotationY = 0;
    let y = 0;

    if (spec.wallRank === null) {
      x = shell.center[0];
      z = shell.center[2];
    } else {
      const wall = byLength[spec.wallRank % byLength.length];
      if (!wall) continue;
      const t = spec.along;
      const cx = wall.start[0] + (wall.end[0] - wall.start[0]) * t;
      const cz = wall.start[2] + (wall.end[2] - wall.start[2]) * t;
      const inset = wall.thickness / 2 + (spec.support === "wall" ? 0 : spec.size.d / 2);
      x = cx + wall.inwardNormal[0] * inset;
      z = cz + wall.inwardNormal[2] * inset;
      rotationY = Math.atan2(wall.inwardNormal[0], wall.inwardNormal[2]);
    }

    if (spec.support === "wall") y = category.mountHeight ?? 1.2;
    if (spec.support === "ceiling") y = shell.height - spec.size.h;

    out.push({
      id: opts.newId(),
      category: spec.category,
      position: { x, y, z },
      rotationY,
      size: { ...spec.size },
      support: spec.support,
      // Flat, mid-range confidence: this is a fixture, and pretending to a
      // per-object confidence it never computed would be theatre.
      confidence: 0.72,
      sourcePhotoIds: [photoIds[0]!],
      lowConfidence: false,
      palette: [spec.palette],
      faceTextureRef: null,
    });
  }

  // Anything that would not fit inside the room is dropped rather than shoved
  // through a wall — a small room gets a smaller demo, not a broken one.
  const [minX, , minZ] = shell.bounds.min;
  const [maxX, , maxZ] = shell.bounds.max;
  return out.filter(
    (o) =>
      o.position.x - o.size.w / 2 >= minX - 0.01 &&
      o.position.x + o.size.w / 2 <= maxX + 0.01 &&
      o.position.z - o.size.d / 2 >= minZ - 0.01 &&
      o.position.z + o.size.d / 2 <= maxZ + 0.01,
  );
}
