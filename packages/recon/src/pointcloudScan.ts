import type { ScanParse } from "@myroom/schema";

import { clustersToSeedBoxes, type ObjectCluster, type SizedCategory } from "./meshObjects.js";
import { traceFloorOutline } from "./outline.js";

/**
 * Stage 0 for point-cloud scans — the PLY a phone LiDAR app exports when asked
 * to "keep more of the room's shape", and the payload of a LAS file
 * (docs/05 §2).
 *
 * A point cloud has no triangles, so the area-weighted machinery in mesh.ts
 * has nothing to weigh — but the room is still in there. This is the worker's
 * numpy pipeline (workers/vision/myroom_vision/pointcloud.py) ported to
 * dependency-free TypeScript so it runs on the device: level the floor by
 * percentile, fit vertical planes with sequential RANSAC in plan view, trace
 * the floor's occupancy outline, and cluster what is left above the floor
 * into object-sized blobs.
 *
 * The client used to *reject* point clouds outright ("export it as GLB") while
 * the upload screen's own help text told Polycam and Scaniverse users to
 * export PLY — the one path guaranteed to fail. The server had this code and
 * never ran; now the device has it.
 *
 * Determinism: RANSAC runs on a fixed-seed PRNG, so the same file always
 * produces the same room.
 */

export interface PointCloudScanOptions {
  /** RANSAC inlier distance in plan metres. */
  toleranceMetres?: number;
  /** A plane needs this many inliers to be a candidate at all. */
  minInliers?: number;
  /** Walls must span this much height — floors project to lines too. */
  minVerticalExtent?: number;
  /** The room lies on one side of a wall; a wardrobe face has points behind it. */
  minOneSided?: number;
  maxPlanes?: number;
  /** Occupancy cell size for the floor outline. */
  cellMetres?: number;
  /** Voxel size for object clustering. */
  voxelMetres?: number;
  /** Clusters smaller than this many points are scanner confetti. */
  minClusterPoints?: number;
  /** Clouds are subsampled to about this many points before fitting. */
  maxPoints?: number;
  categories?: readonly SizedCategory[];
}

const DEFAULTS: Required<Omit<PointCloudScanOptions, "categories">> = {
  toleranceMetres: 0.05,
  minInliers: 60,
  minVerticalExtent: 0.8,
  minOneSided: 0.9,
  maxPlanes: 12,
  cellMetres: 0.15,
  voxelMetres: 0.12,
  minClusterPoints: 40,
  maxPoints: 120_000,
};

/** Deterministic 32-bit PRNG (mulberry32) — RANSAC must not flake. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

interface FittedPlane {
  /** normal · p = offset in plan coordinates (x, −z) */
  nx: number;
  ny: number;
  offset: number;
  inliers: Uint32Array;
}

/** Fraction of the cloud on the majority side of a candidate plane. */
function oneSidedFraction(planX: Float64Array, planY: Float64Array, indices: Uint32Array, nx: number, ny: number, offset: number, tolerance: number): number {
  let positive = 0;
  let outside = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    const signed = planX[i]! * nx + planY[i]! * ny - offset;
    if (Math.abs(signed) > tolerance) {
      outside++;
      if (signed > 0) positive++;
    }
  }
  if (outside === 0) return 1;
  const fraction = positive / outside;
  return Math.max(fraction, 1 - fraction);
}

/**
 * Parse a raw point cloud (world metres, Y-up) into the same ScanParse a mesh
 * produces: an ordered wall outline, a ceiling height, and seed boxes.
 */
export function parsePointCloudScan(
  positions: Float32Array,
  format: ScanParse["format"],
  options: PointCloudScanOptions = {},
): ScanParse {
  const opts = { ...DEFAULTS, ...options };
  const empty: ScanParse = {
    format,
    parsed: false,
    failure: null,
    walls: [],
    ceilingHeight: null,
    seedBoxes: [],
    disagreements: [],
    silhouette: [],
  };

  const total = Math.floor(positions.length / 3);
  if (total < 500) {
    return { ...empty, failure: "that scan doesn't have enough points to read" };
  }

  // Deterministic stride subsample: RANSAC and the occupancy trace need shape,
  // not every point.
  const stride = Math.max(1, Math.ceil(total / opts.maxPoints));
  const n = Math.floor((total + stride - 1) / stride);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  for (let i = 0, j = 0; j < n; i += stride, j++) {
    px[j] = positions[i * 3]!;
    py[j] = positions[i * 3 + 1]!;
    pz[j] = positions[i * 3 + 2]!;
  }

  const sortedY = Float64Array.from(py).sort();
  const floorY = percentile(sortedY, 2);
  const topY = percentile(sortedY, 98);
  const height = topY - floorY;
  if (height < 0.5) {
    return { ...empty, failure: "that scan is too flat to be a room" };
  }
  const ceilingHeight = height > 1.5 ? height : null;

  // Plan view (x, −z), matching the mesh path and the worker.
  const planX = px;
  const planY = new Float64Array(n);
  for (let i = 0; i < n; i++) planY[i] = -pz[i]!;

  // --- sequential RANSAC for vertical planes -------------------------------
  const rand = mulberry32(12345);
  const aboveFloor: number[] = [];
  for (let i = 0; i < n; i++) if (py[i]! > floorY + 0.15) aboveFloor.push(i);
  const aboveFloorIdx = Uint32Array.from(aboveFloor);
  let remaining = aboveFloorIdx.length >= opts.minInliers ? aboveFloorIdx.slice() : Uint32Array.from({ length: n }, (_, i) => i);

  const planes: FittedPlane[] = [];
  const wallInlierSet = new Set<number>();

  while (remaining.length >= opts.minInliers && planes.length < opts.maxPlanes) {
    let bestInliers: Uint32Array | null = null;
    let bestNx = 0;
    let bestNy = 0;
    let bestOffset = 0;
    for (let iter = 0; iter < 200; iter++) {
      const i = remaining[Math.floor(rand() * remaining.length)]!;
      const j = remaining[Math.floor(rand() * remaining.length)]!;
      if (i === j) continue;
      const dx = planX[j]! - planX[i]!;
      const dy = planY[j]! - planY[i]!;
      const length = Math.hypot(dx, dy);
      if (length < 0.25) continue;
      const nx = -dy / length;
      const ny = dx / length;
      const offset = nx * planX[i]! + ny * planY[i]!;
      const inliers: number[] = [];
      for (let k = 0; k < remaining.length; k++) {
        const idx = remaining[k]!;
        if (Math.abs(planX[idx]! * nx + planY[idx]! * ny - offset) <= opts.toleranceMetres) inliers.push(idx);
      }
      if (bestInliers === null || inliers.length > bestInliers.length) {
        bestInliers = Uint32Array.from(inliers);
        bestNx = nx;
        bestNy = ny;
        bestOffset = offset;
      }
    }
    if (bestInliers === null || bestInliers.length < opts.minInliers) break;

    let minY = Infinity;
    let maxY = -Infinity;
    for (const idx of bestInliers) {
      const y = py[idx]!;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const verticalExtent = maxY - minY;
    const oneSided = oneSidedFraction(planX, planY, aboveFloorIdx, bestNx, bestNy, bestOffset, opts.toleranceMetres);

    const inlierSet = new Set(bestInliers);
    if (verticalExtent < opts.minVerticalExtent || oneSided < opts.minOneSided) {
      // Not a wall — drop these points and keep looking, rather than dressing
      // a wardrobe front (or the floor) up as one.
      remaining = remaining.filter((idx) => !inlierSet.has(idx));
      continue;
    }

    // Refit on all inliers: the two-point hypothesis only had to find them.
    let cx = 0;
    let cy = 0;
    for (const idx of bestInliers) {
      cx += planX[idx]!;
      cy += planY[idx]!;
    }
    cx /= bestInliers.length;
    cy /= bestInliers.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const idx of bestInliers) {
      const dx = planX[idx]! - cx;
      const dy = planY[idx]! - cy;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    // Principal direction of the 2×2 covariance — the line the inliers lie on.
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dirX = Math.cos(theta);
    const dirY = Math.sin(theta);
    const nx = -dirY;
    const ny = dirX;
    const offset = nx * cx + ny * cy;

    planes.push({ nx, ny, offset, inliers: bestInliers });
    for (const idx of bestInliers) wallInlierSet.add(idx);
    remaining = remaining.filter((idx) => !inlierSet.has(idx));
  }

  if (planes.length < 2) {
    return { ...empty, failure: "we couldn't find walls in that scan" };
  }

  // --- room orientation & floor outline ------------------------------------
  // The principal angle comes from the longest fitted wall's direction.
  let longest = 0;
  let angle = 0;
  const wallSegments: { ax: number; ay: number; bx: number; by: number }[] = [];
  for (const plane of planes) {
    const dirX = plane.ny;
    const dirY = -plane.nx;
    let minT = Infinity;
    let maxT = -Infinity;
    let minIdx = plane.inliers[0]!;
    let maxIdx = plane.inliers[0]!;
    for (const idx of plane.inliers) {
      const t = planX[idx]! * dirX + planY[idx]! * dirY;
      if (t < minT) {
        minT = t;
        minIdx = idx;
      }
      if (t > maxT) {
        maxT = t;
        maxIdx = idx;
      }
    }
    const ax = planX[minIdx]!;
    const ay = planY[minIdx]!;
    const bx = planX[maxIdx]!;
    const by = planY[maxIdx]!;
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 0.4) continue; // a 20 cm sliver is noise, not a wall
    wallSegments.push({ ax, ay, bx, by });
    if (length > longest) {
      longest = length;
      angle = Math.atan2(by - ay, bx - ax);
    }
  }
  if (wallSegments.length < 2) {
    return { ...empty, failure: "we couldn't find walls in that scan" };
  }

  // Occupancy in the room's own frame. Everything between the floor and the
  // ceiling counts — furniture fills the interior, which is exactly what the
  // outline tracer wants.
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cellSet = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) {
    if (py[i]! > floorY + height * 0.9) continue; // ceiling points say nothing about the floor
    // Plan → room frame is the inverse rotation.
    const u = planX[i]! * cos + planY[i]! * sin;
    const v = -planX[i]! * sin + planY[i]! * cos;
    const cu = Math.round(u / opts.cellMetres) * opts.cellMetres;
    const cv = Math.round(v / opts.cellMetres) * opts.cellMetres;
    const key = `${Math.round(cu * 1000)},${Math.round(cv * 1000)}`;
    if (!cellSet.has(key)) cellSet.set(key, [cu, cv]);
  }
  const cells = [...cellSet.values()];
  const traced = traceFloorOutline(cells, 0, { cellMetres: opts.cellMetres });

  if (!traced || traced.length < 3) {
    return { ...empty, failure: "we couldn't trace a floor outline in that scan" };
  }
  const corners = traced.map((p) => ({
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos,
  }));
  const walls = corners.map((start, i) => ({
    start,
    end: corners[(i + 1) % corners.length]!,
    height: ceilingHeight,
  }));

  // --- object clusters ------------------------------------------------------
  // Everything that is neither floor, ceiling nor wall, voxel flood-filled
  // into blobs (26-connected — the worker's cluster_above_floor).
  const voxel = opts.voxelMetres;
  const clusterIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (wallInlierSet.has(i)) continue;
    const y = py[i]!;
    if (y < floorY + 0.05) continue;
    if (ceilingHeight !== null && y > floorY + height - 0.3) continue;
    // Points hugging a wall plane are the wall, whether RANSAC claimed them or not.
    let nearWall = false;
    for (const plane of planes) {
      if (Math.abs(planX[i]! * plane.nx + planY[i]! * plane.ny - plane.offset) < 0.12) {
        nearWall = true;
        break;
      }
    }
    if (nearWall) continue;
    clusterIdx.push(i);
  }

  const clusters: ObjectCluster[] = [];
  if (clusterIdx.length >= opts.minClusterPoints) {
    const lookup = new Map<string, number[]>();
    for (const i of clusterIdx) {
      const key = `${Math.floor(px[i]! / voxel)},${Math.floor(py[i]! / voxel)},${Math.floor(pz[i]! / voxel)}`;
      const bucket = lookup.get(key);
      if (bucket) bucket.push(i);
      else lookup.set(key, [i]);
    }
    const seen = new Set<string>();
    for (const startKey of lookup.keys()) {
      if (seen.has(startKey)) continue;
      seen.add(startKey);
      const stack = [startKey];
      const members: number[] = [];
      while (stack.length) {
        const current = stack.pop()!;
        members.push(...lookup.get(current)!);
        const [vx, vy, vz] = current.split(",").map(Number) as [number, number, number];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              const neighbour = `${vx + dx},${vy + dy},${vz + dz}`;
              if (lookup.has(neighbour) && !seen.has(neighbour)) {
                seen.add(neighbour);
                stack.push(neighbour);
              }
            }
          }
        }
      }
      if (members.length < opts.minClusterPoints) continue;

      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      let minH = Infinity;
      let maxH = -Infinity;
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      for (const i of members) {
        const u = planX[i]! * cos + planY[i]! * sin;
        const v = -planX[i]! * sin + planY[i]! * cos;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
        const y = py[i]!;
        if (y < minH) minH = y;
        if (y > maxH) maxH = y;
        sumX += px[i]!;
        sumY += y;
        sumZ += pz[i]!;
      }
      const width = maxU - minU;
      const depth = maxV - minV;
      const boxHeight = maxH - minH;
      // Scanner confetti: thin in every axis.
      if (Math.max(width, depth, boxHeight) < 0.15) continue;
      // Room-sized "clusters" are the parts of the shell the guards missed.
      if (width > 4 || depth > 4 || boxHeight > 2.6) continue;
      clusters.push({
        cx: sumX / members.length,
        cy: sumY / members.length,
        cz: sumZ / members.length,
        width,
        depth,
        height: boxHeight,
        baseY: minH - floorY,
        area: members.length * voxel * voxel,
        rotationY: angle,
      });
    }
  }

  return {
    format,
    parsed: true,
    failure: null,
    walls,
    ceilingHeight,
    seedBoxes: clustersToSeedBoxes(clusters, options.categories ?? [], floorY),
    disagreements: [],
    silhouette: cells.map(([u, v]) => {
      const x = u * cos - v * sin;
      const y = u * sin + v * cos;
      return [x, y] as [number, number];
    }),
  };
}
