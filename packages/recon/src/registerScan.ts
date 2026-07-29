import type { ScanWallLine } from "./refine.js";

/**
 * Register a scan to the drawn plan (docs/05 §2): the rigid 2D transform that
 * lays the scan's walls onto the drawn outline. This is the worker's
 * register.py ported to TypeScript, because it turned out to be the missing
 * piece of the on-device path: seed boxes were measured in the *scan's*
 * coordinate frame and dropped into the *plan's* frame untransformed, so a
 * scanned couch landed wherever the scanner's session origin happened to be —
 * "nothing was placed right" was exactly true.
 *
 * Candidate rotations come from pairing wall headings (a room's walls are its
 * own best feature descriptor), each refined by a few iterations of
 * point-to-segment ICP with a closed-form 2D Kabsch step.
 */

export interface Registration {
  /** radians, counter-clockwise in plan space */
  rotation: number;
  tx: number;
  ty: number;
  /** mean distance from transformed scan samples to the drawn outline, metres */
  residual: number;
}

type Pt = { x: number; y: number };

export function applyRegistration(reg: Registration, p: Pt): Pt {
  const c = Math.cos(reg.rotation);
  const s = Math.sin(reg.rotation);
  return { x: p.x * c - p.y * s + reg.tx, y: p.x * s + p.y * c + reg.ty };
}

/** Evenly sample points along segments, ~`spacing` metres apart. */
function sampleSegments(segments: [Pt, Pt][], spacing = 0.1): Pt[] {
  const out: Pt[] = [];
  for (const [a, b] of segments) {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.floor(length / spacing) + 1);
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function nearestOnSegment(p: Pt, a: Pt, b: Pt): { point: Pt; distance: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const denom = abx * abx + aby * aby || 1e-12;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / denom));
  const point = { x: a.x + t * abx, y: a.y + t * aby };
  return { point, distance: Math.hypot(p.x - point.x, p.y - point.y) };
}

function nearest(p: Pt, segments: [Pt, Pt][]): { point: Pt; distance: number } {
  let best = nearestOnSegment(p, segments[0]![0], segments[0]![1]);
  for (let i = 1; i < segments.length; i++) {
    const candidate = nearestOnSegment(p, segments[i]![0], segments[i]![1]);
    if (candidate.distance < best.distance) best = candidate;
  }
  return best;
}

function meanResidual(points: Pt[], segments: [Pt, Pt][]): number {
  let sum = 0;
  for (const p of points) sum += nearest(p, segments).distance;
  return sum / points.length;
}

/** Closed-form best rigid transform source → target (2D Kabsch). */
function kabsch2d(source: Pt[], target: Pt[]): Registration {
  let scx = 0;
  let scy = 0;
  let tcx = 0;
  let tcy = 0;
  for (let i = 0; i < source.length; i++) {
    scx += source[i]!.x;
    scy += source[i]!.y;
    tcx += target[i]!.x;
    tcy += target[i]!.y;
  }
  scx /= source.length;
  scy /= source.length;
  tcx /= target.length;
  tcy /= target.length;
  // 2×2 cross-covariance; the optimal rotation angle has a closed form.
  let sxx = 0;
  let sxy = 0;
  let syx = 0;
  let syy = 0;
  for (let i = 0; i < source.length; i++) {
    const sx = source[i]!.x - scx;
    const sy = source[i]!.y - scy;
    const tx = target[i]!.x - tcx;
    const ty = target[i]!.y - tcy;
    sxx += sx * tx;
    sxy += sx * ty;
    syx += sy * tx;
    syy += sy * ty;
  }
  const rotation = Math.atan2(sxy - syx, sxx + syy);
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return { rotation, tx: tcx - (scx * c - scy * s), ty: tcy - (scx * s + scy * c), residual: Infinity };
}

/**
 * Best rigid transform taking scan walls onto the drawn loop, or null when
 * there isn't enough structure to register. `loop` is the plan's closed
 * vertex ring.
 */
export function registerScanToPlan(
  scanWalls: readonly ScanWallLine[],
  loop: readonly Pt[],
  { icpIterations = 20 }: { icpIterations?: number } = {},
): Registration | null {
  if (scanWalls.length < 2 || loop.length < 3) return null;

  const planSegments: [Pt, Pt][] = loop.map((p, i) => [p, loop[(i + 1) % loop.length]!]);
  const scanSegments: [Pt, Pt][] = scanWalls.map((w) => [
    { x: w.start[0], y: w.start[1] },
    { x: w.end[0], y: w.end[1] },
  ]);
  const scanPoints = sampleSegments(scanSegments);
  if (scanPoints.length === 0) return null;

  const centroid = (pts: Pt[]): Pt => {
    let x = 0;
    let y = 0;
    for (const p of pts) {
      x += p.x;
      y += p.y;
    }
    return { x: x / pts.length, y: y / pts.length };
  };
  const scanCentroid = centroid(scanPoints);
  const planCentroid = centroid(sampleSegments(planSegments));

  const heading = ([a, b]: [Pt, Pt]) => Math.atan2(b.y - a.y, b.x - a.x);
  const candidates = new Set<number>();
  for (const scanSeg of scanSegments) {
    for (const planSeg of planSegments) {
      for (let quarter = 0; quarter < 4; quarter++) {
        // Walls are undirected, so every 90° flip is also a candidate. Round
        // to 0.25° so near-duplicates collapse.
        const angle = heading(planSeg) - heading(scanSeg) + (quarter * Math.PI) / 2;
        candidates.add(Math.round(angle * (720 / Math.PI)) / (720 / Math.PI));
      }
    }
  }

  const finished: Registration[] = [];
  for (const angle of candidates) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let current: Registration = {
      rotation: angle,
      tx: planCentroid.x - (scanCentroid.x * c - scanCentroid.y * s),
      ty: planCentroid.y - (scanCentroid.x * s + scanCentroid.y * c),
      residual: Infinity,
    };

    for (let iter = 0; iter < icpIterations; iter++) {
      const moved = scanPoints.map((p) => applyRegistration(current, p));
      const residual = meanResidual(moved, planSegments);
      if (Math.abs(residual - current.residual) < 1e-5) {
        current = { ...current, residual };
        break;
      }
      current = { ...current, residual };
      // Pull each sample onto its nearest projection, re-solve in closed form.
      const targets = moved.map((p) => nearest(p, planSegments).point);
      const solved = kabsch2d(scanPoints, targets);
      solved.residual = meanResidual(
        scanPoints.map((p) => applyRegistration(solved, p)),
        planSegments,
      );
      current = solved;
    }

    finished.push(current);
  }
  if (finished.length === 0) return null;

  /*
   * Symmetry tie-break. Walls alone cannot tell a rectangle from itself
   * rotated 180° (or a square from its quarter turns): both fits register
   * with identical residual, and picking by residual alone means the
   * furniture of a symmetric room lands flipped or not by floating-point
   * luck. Among candidates within a whisker of the best, prefer the smallest
   * rotation — deterministic, and exactly right for the scan-first flow,
   * where the plan was built FROM the scan and identity is the true answer.
   */
  const best = finished.reduce((a, b) => (b.residual < a.residual ? b : a));
  const margin = Math.max(0.02, best.residual * 0.1);
  const turn = (r: number) => {
    const t = (((r + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return Math.abs(t);
  };
  let chosen = best;
  for (const candidate of finished) {
    if (candidate.residual <= best.residual + margin && turn(candidate.rotation) < turn(chosen.rotation)) {
      chosen = candidate;
    }
  }
  return chosen;
}
