"""Mesh / point-cloud scans → wall lines and object clusters (docs/05 §2).

For a ``.ply`` or ``.glb`` there is no parametric room to read, so the room has
to be recovered: level the floor, fit vertical planes with RANSAC, and cluster
what is left above the floor into object-sized blobs.

Implemented on numpy alone. Open3D is the production dependency for the heavy
variants of these operations (it is MIT, docs/08 §3), but the algorithms below
are what Stage 0 actually needs and are testable without a native build.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .roomplan import ScanWall


class PlyError(ValueError):
    """The file is not a PLY we can read."""


def read_ply(data: bytes) -> np.ndarray:
    """Read vertex XYZ from an ASCII or binary-little-endian PLY.

    Returns an ``(n, 3)`` float array. Faces are ignored: for room extraction
    the vertices *are* the point cloud.
    """
    if not data.startswith(b"ply"):
        raise PlyError("not a PLY file")
    end = data.find(b"end_header")
    if end == -1:
        raise PlyError("PLY header is not terminated")
    header_bytes = data[:end]
    body_start = data.index(b"\n", end) + 1
    header = header_bytes.decode("ascii", errors="replace").splitlines()

    fmt = next((line.split()[1] for line in header if line.startswith("format")), None)
    if fmt not in {"ascii", "binary_little_endian"}:
        raise PlyError(f"unsupported PLY format: {fmt}")

    # Walk elements in order; only the vertex element's properties matter, but
    # the count of every preceding element is needed to find where it starts.
    element: str | None = None
    counts: dict[str, int] = {}
    order: list[str] = []
    properties: dict[str, list[tuple[str, str]]] = {}
    for line in header:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "element" and len(parts) >= 3:
            element = parts[1]
            counts[element] = int(parts[2])
            order.append(element)
            properties[element] = []
        elif parts[0] == "property" and element is not None:
            if parts[1] == "list":
                properties[element].append(("list", parts[-1]))
            else:
                properties[element].append((parts[1], parts[-1]))

    if "vertex" not in counts:
        raise PlyError("PLY has no vertex element")
    props = properties["vertex"]
    names = [name for _, name in props]
    for axis in ("x", "y", "z"):
        if axis not in names:
            raise PlyError("PLY vertices have no x/y/z")

    if fmt == "ascii":
        rows = []
        text = data[body_start:].decode("ascii", errors="replace").split("\n")
        for line in text[: counts["vertex"]]:
            values = line.split()
            if len(values) < len(props):
                continue
            rows.append([float(values[names.index(a)]) for a in ("x", "y", "z")])
        if not rows:
            raise PlyError("PLY declared vertices but none could be read")
        return np.asarray(rows, dtype=float)

    np_types = {
        "char": "i1", "uchar": "u1", "int8": "i1", "uint8": "u1",
        "short": "<i2", "ushort": "<u2", "int16": "<i2", "uint16": "<u2",
        "int": "<i4", "uint": "<u4", "int32": "<i4", "uint32": "<u4",
        "float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8",
    }
    try:
        dtype = np.dtype([(name, np_types[kind]) for kind, name in props])
    except KeyError as exc:  # pragma: no cover - exotic property types
        raise PlyError(f"unsupported PLY property type {exc}") from exc
    raw = np.frombuffer(data, dtype=dtype, count=counts["vertex"], offset=body_start)
    return np.stack([raw["x"], raw["y"], raw["z"]], axis=1).astype(float)


def floor_height(points: np.ndarray, percentile: float = 2.0) -> float:
    """Floor elevation, robust to a few stray points below the floor plane."""
    return float(np.percentile(points[:, 1], percentile))


@dataclass
class FittedPlane:
    """A vertical plane: ``normal · p = offset`` in the plan's 2D frame."""

    normal: tuple[float, float]
    offset: float
    inliers: np.ndarray


def fit_vertical_planes(
    points: np.ndarray,
    *,
    tolerance: float = 0.05,
    min_inliers: int = 60,
    min_vertical_extent: float = 0.8,
    min_one_sided: float = 0.9,
    max_planes: int = 12,
    rng: np.random.Generator | None = None,
) -> list[FittedPlane]:
    """Sequential RANSAC for vertical planes, in plan coordinates ``(x, −z)``.

    Vertical planes project to *lines* in plan view, so the fit is a 2D line
    fit over the points' plan footprint — cheaper and better conditioned than
    fitting 3D planes and then discarding the vertical component.

    Three guards separate walls from everything else that is planar:

    * points near the floor plane are excluded up front, and
    * a surviving plane must span at least ``min_vertical_extent`` metres in Y —
      a floor projects to a filled rectangle in plan view, so *any* line through
      it collects inliers; without the height test RANSAC happily reports
      diagonals across the floor as walls, and
    * the room must lie on **one side** of it. This is what makes a wall a wall
      rather than the flat front of a wardrobe: a densely scanned furniture face
      is a perfectly good plane with points on both sides of it.
    """
    rng = rng or np.random.default_rng(12345)
    plan = np.stack([points[:, 0], -points[:, 2]], axis=1)
    floor = floor_height(points)
    above_floor = np.flatnonzero(points[:, 1] > floor + 0.15)
    remaining = above_floor if len(above_floor) >= min_inliers else np.arange(len(plan))
    planes: list[FittedPlane] = []

    while len(remaining) >= min_inliers and len(planes) < max_planes:
        best_inliers: np.ndarray | None = None
        best_model: tuple[tuple[float, float], float] | None = None
        for _ in range(200):
            i, j = rng.choice(len(remaining), size=2, replace=False)
            a = plan[remaining[i]]
            b = plan[remaining[j]]
            direction = b - a
            length = float(np.linalg.norm(direction))
            if length < 0.25:
                continue
            normal = np.array([-direction[1], direction[0]]) / length
            offset = float(normal @ a)
            distances = np.abs(plan[remaining] @ normal - offset)
            inliers = remaining[distances <= tolerance]
            if best_inliers is None or len(inliers) > len(best_inliers):
                best_inliers = inliers
                best_model = ((float(normal[0]), float(normal[1])), offset)
        if best_inliers is None or best_model is None or len(best_inliers) < min_inliers:
            break
        vertical_extent = float(np.ptp(points[best_inliers, 1]))
        one_sided = _one_sided_fraction(plan[above_floor], best_model, tolerance)
        if vertical_extent < min_vertical_extent or one_sided < min_one_sided:
            # Not a wall — drop these points and keep looking rather than
            # returning a horizontal surface, or the flat front of a wardrobe,
            # dressed as a wall.
            remaining = np.setdiff1d(remaining, best_inliers, assume_unique=False)
            continue

        # Refit on all inliers: the two-point hypothesis only had to find them.
        subset = plan[best_inliers]
        centroid = subset.mean(axis=0)
        _, _, vh = np.linalg.svd(subset - centroid)
        direction = vh[0]
        normal = np.array([-direction[1], direction[0]])
        normal /= np.linalg.norm(normal)
        offset = float(normal @ centroid)
        planes.append(
            FittedPlane((float(normal[0]), float(normal[1])), offset, best_inliers.copy())
        )
        remaining = np.setdiff1d(remaining, best_inliers, assume_unique=False)

    return planes


def _one_sided_fraction(
    plan: np.ndarray,
    model: tuple[tuple[float, float], float],
    tolerance: float,
) -> float:
    """Fraction of the cloud lying on the majority side of a candidate plane."""
    normal = np.asarray(model[0])
    signed = plan @ normal - model[1]
    outside = np.abs(signed) > tolerance
    if not outside.any():
        return 1.0
    positive = float((signed[outside] > 0).mean())
    return max(positive, 1.0 - positive)


def planes_to_walls(points: np.ndarray, planes: list[FittedPlane], height: float | None) -> list[ScanWall]:
    """Turn each fitted plane into the segment its inliers actually span."""
    plan = np.stack([points[:, 0], -points[:, 2]], axis=1)
    walls: list[ScanWall] = []
    for plane in planes:
        subset = plan[plane.inliers]
        direction = np.array([-plane.normal[1], plane.normal[0]])
        t = subset @ direction
        a = subset[int(np.argmin(t))]
        b = subset[int(np.argmax(t))]
        wall = ScanWall((float(a[0]), float(a[1])), (float(b[0]), float(b[1])), height)
        # A 20 cm sliver is noise, not a wall.
        if wall.length >= 0.4:
            walls.append(wall)
    return walls


def cluster_above_floor(
    points: np.ndarray,
    *,
    floor: float,
    wall_inliers: np.ndarray | None = None,
    voxel: float = 0.12,
    min_points: int = 40,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Euclidean clustering of everything that is neither floor nor wall.

    Voxelizes, then flood-fills 26-connected occupied voxels — the same result
    as a radius-graph clustering at this resolution, without the O(n²) step.
    Returns ``(min_corner, max_corner)`` pairs in world coordinates.
    """
    mask = points[:, 1] > floor + 0.05
    if wall_inliers is not None and len(wall_inliers):
        keep = np.ones(len(points), dtype=bool)
        keep[wall_inliers] = False
        mask &= keep
    subset = points[mask]
    if len(subset) < min_points:
        return []

    keys = np.floor(subset / voxel).astype(np.int64)
    lookup: dict[tuple[int, int, int], list[int]] = {}
    for index, key in enumerate(map(tuple, keys)):
        lookup.setdefault(key, []).append(index)

    seen: set[tuple[int, int, int]] = set()
    neighbours = [
        (dx, dy, dz)
        for dx in (-1, 0, 1)
        for dy in (-1, 0, 1)
        for dz in (-1, 0, 1)
        if (dx, dy, dz) != (0, 0, 0)
    ]
    boxes: list[tuple[np.ndarray, np.ndarray]] = []
    for key in lookup:
        if key in seen:
            continue
        stack = [key]
        seen.add(key)
        members: list[int] = []
        while stack:
            current = stack.pop()
            members.extend(lookup[current])
            for offset in neighbours:
                neighbour = (current[0] + offset[0], current[1] + offset[1], current[2] + offset[2])
                if neighbour in lookup and neighbour not in seen:
                    seen.add(neighbour)
                    stack.append(neighbour)
        if len(members) < min_points:
            continue
        cluster = subset[members]
        boxes.append((cluster.min(axis=0), cluster.max(axis=0)))
    return boxes
