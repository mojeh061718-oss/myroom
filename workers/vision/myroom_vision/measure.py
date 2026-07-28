"""Stage 3 — object measurement (docs/05 §5).

Back-project a mask through the corrected depth map, then fit an oriented
bounding box: floor-aligned for floor objects, wall-plane-aligned for wall
mounts. Merge with LiDAR seed boxes when present — the scan wins on size, the
photo wins on category and appearance.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class OrientedBox:
    """Floor-aligned box: centre on the floor plane, size in metres, yaw."""

    position: tuple[float, float, float]
    rotation_y: float
    size: tuple[float, float, float]

    def as_dict(self) -> dict[str, object]:
        return {
            "position": {"x": self.position[0], "y": self.position[1], "z": self.position[2]},
            "rotationY": self.rotation_y,
            "size": {"w": self.size[0], "h": self.size[1], "d": self.size[2]},
        }


def trim_outliers(points: np.ndarray, percentile: float = 2.0) -> np.ndarray:
    """Drop the extreme few percent per axis.

    Mask edges bleed onto whatever is behind the object, and one bled pixel at
    the far wall would otherwise stretch the box by metres.
    """
    if len(points) < 20:
        return points
    lo = np.percentile(points, percentile, axis=0)
    hi = np.percentile(points, 100 - percentile, axis=0)
    keep = np.all((points >= lo) & (points <= hi), axis=1)
    return points[keep] if keep.sum() >= 8 else points


def oriented_box(points: np.ndarray, *, floor_y: float = 0.0) -> OrientedBox | None:
    """Fit a floor-aligned oriented box to a 3D point set.

    The yaw comes from a PCA of the footprint: furniture is boxy, so its
    dominant horizontal axis is its facing direction. Height is measured from
    the floor, not from the lowest point, so an object whose legs are occluded
    doesn't float.
    """
    points = trim_outliers(np.asarray(points, dtype=float))
    if len(points) < 8:
        return None

    footprint = points[:, [0, 2]]
    centred = footprint - footprint.mean(axis=0)
    if np.allclose(centred, 0):
        return None
    _, _, vh = np.linalg.svd(centred, full_matrices=False)
    axis = vh[0]

    # A Y rotation of θ takes the object's local +x axis to (cos θ, −sin θ) in
    # world (x, z) — so the footprint's principal direction gives θ directly.
    # Reading it as atan2(x, z) instead would silently mirror every box.
    yaw = float(np.arctan2(-axis[1], axis[0]))
    c, s = np.cos(yaw), np.sin(yaw)
    world_from_local = np.array([[c, s], [-s, c]])
    local = centred @ world_from_local  # = centred @ inv(world_from_local).T
    lo = local.min(axis=0)
    hi = local.max(axis=0)
    width = float(hi[0] - lo[0])
    depth = float(hi[1] - lo[1])

    local_centre = (lo + hi) / 2
    centre = footprint.mean(axis=0) + local_centre @ world_from_local.T

    top = float(points[:, 1].max())
    height = max(top - floor_y, 0.02)
    if width <= 0.02 or depth <= 0.02:
        return None
    return OrientedBox(
        position=(float(centre[0]), float(floor_y), float(centre[1])),
        rotation_y=yaw,
        size=(width, height, depth),
    )


def merge_with_seed(measured: OrientedBox, seed: OrientedBox) -> OrientedBox:
    """LiDAR box wins size and yaw; the photo's box keeps nothing but its class.

    docs/05 §5: "Merge with LiDAR seed boxes when present (LiDAR box wins size;
    photo wins category/appearance)".
    """
    return OrientedBox(position=seed.position, rotation_y=seed.rotation_y, size=seed.size)


def seed_for(measured: OrientedBox, seeds: list[OrientedBox], *, max_distance: float = 0.6) -> OrientedBox | None:
    """The scan box most plausibly describing the same object, if any."""
    best: tuple[float, OrientedBox] | None = None
    for seed in seeds:
        distance = float(
            np.hypot(seed.position[0] - measured.position[0], seed.position[2] - measured.position[2])
        )
        if distance <= max_distance and (best is None or distance < best[0]):
            best = (distance, seed)
    return best[1] if best else None
