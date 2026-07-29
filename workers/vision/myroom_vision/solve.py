"""Stage 2 — camera & scale solve (docs/05 §4), the parts that are geometry.

The plan gives what the vision models lack: exact wall lengths and a known
ceiling height. Layout estimation itself needs a model (see :mod:`detect`), but
everything downstream of it — intrinsics from EXIF, pose from correspondences,
and the depth rescale that turns "roughly metric" monocular depth into
plan-accurate depth — is arithmetic, and lives here where it can be tested.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: 35 mm-equivalent focal length assumed when a photo carries no EXIF.
DEFAULT_FOCAL_35MM = 26.0


def intrinsics_from_exif(
    width: int,
    height: int,
    focal_35mm: float | None = None,
) -> np.ndarray:
    """Camera matrix from image size and a 35 mm-equivalent focal length.

    The 35 mm equivalent is defined against a 36 mm-wide frame, so the focal
    length in pixels is ``f_35 / 36 * image_width``.
    """
    focal = focal_35mm if focal_35mm and focal_35mm > 0 else DEFAULT_FOCAL_35MM
    fx = focal / 36.0 * width
    return np.array([[fx, 0.0, width / 2.0], [0.0, fx, height / 2.0], [0.0, 0.0, 1.0]])


def horizontal_fov(intrinsics: np.ndarray, width: int) -> float:
    return float(2.0 * np.arctan(width / (2.0 * intrinsics[0, 0])))


@dataclass
class Pose:
    """Camera pose in world metres/radians (Y-up, plan frame)."""

    position: np.ndarray
    yaw: float
    pitch: float

    def to_world(self, camera_points: np.ndarray) -> np.ndarray:
        """Camera-space points (x right, y up, −z forward) → world."""
        cy, sy = np.cos(self.yaw), np.sin(self.yaw)
        cp, sp = np.cos(self.pitch), np.sin(self.pitch)
        rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
        ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
        return camera_points @ (ry @ rx).T + self.position


def fit_metric_depth(
    inverse_depth: np.ndarray,
    constraints: list[tuple[np.ndarray, float]],
) -> tuple[np.ndarray, tuple[float, float]]:
    """Turn affine-invariant network output into metres (docs/05 §4 step 3).

    Depth Anything V2's non-metric checkpoints emit *affine-invariant inverse
    depth*: the network's output ``p`` relates to true distance ``d`` as

        1 / d = a * p + b

    with **both** ``a`` and ``b`` unknown and arbitrary per image. Recovering
    only a multiplicative scale — which is what :func:`rescale_depth` does —
    silently assumes ``b == 0``, and that assumption is false.

    The cost is not uniform, which is what makes it dangerous. A scale-only
    solve is exact at whatever plane it was anchored to and drifts further away
    with distance from it. Measured on a synthetic 2–6 m room anchored at the
    far wall: 4 cm of error at the anchor, 54 cm mid-room, 65 cm at the near
    end — against docs/05 §9's ±15 cm budget. The error is smallest exactly
    where it was measured and largest in the middle of the room, where the
    furniture is.

    Two unknowns need two constraints, and the plan supplies plenty: the tagged
    wall's plane, the floor (known for every pixel below the floor–wall seam),
    and the ceiling height. Each ``(mask, metres)`` pair contributes its pixels;
    the fit is least-squares over all of them, so a floor plane alone is enough
    and more constraints only help.

    Returns ``(metric_depth, (a, b))``.
    """
    rows: list[float] = []
    rhs: list[float] = []
    for mask, metres in constraints:
        if mask.shape != inverse_depth.shape:
            raise ValueError("every constraint mask must match the depth map's shape")
        if not np.isfinite(metres) or metres <= 0:
            raise ValueError(f"constraint distance must be positive metres, got {metres}")
        selected = inverse_depth[mask.astype(bool)]
        selected = selected[np.isfinite(selected)]
        if selected.size == 0:
            continue
        # Median per constraint, so a few pixels of a sofa in front of the wall
        # cannot drag the fit — the same reasoning as the old scale-only path,
        # applied per plane rather than once globally.
        rows.append(float(np.median(selected)))
        rhs.append(1.0 / float(metres))

    if len(rows) < 2:
        raise ValueError(
            "an affine depth solve needs at least two distinct distance constraints; "
            f"got {len(rows)}. Supply the floor plane as well as the tagged wall."
        )

    design = np.stack([np.asarray(rows, dtype=np.float64), np.ones(len(rows))], axis=1)
    (a, b), *_ = np.linalg.lstsq(design, np.asarray(rhs, dtype=np.float64), rcond=None)
    if not np.isfinite(a) or not np.isfinite(b) or a == 0:
        raise ValueError("depth solve produced a degenerate fit")

    denominator = a * inverse_depth.astype(np.float64) + b
    # Behind the camera or at infinity: mark rather than emit a negative metre.
    with np.errstate(divide="ignore", invalid="ignore"):
        metric = np.where(denominator > 1e-9, 1.0 / denominator, np.inf)
    return metric.astype(np.float32), (float(a), float(b))


def rescale_depth(
    depth: np.ndarray,
    *,
    wall_mask: np.ndarray,
    expected_distance: float,
) -> tuple[np.ndarray, float]:
    """Scale a depth map so the tagged wall lands where the plan says.

    Correct **only** for depth that is already metric up to a single scale —
    i.e. the ``Metric-Indoor`` checkpoints. For affine-invariant output (the
    plain Depth Anything V2 small/base/large checkpoints, which is what
    :mod:`myroom_vision.depth` loads) this is the wrong model: it leaves the
    shift unrecovered and produces error that grows with distance from the
    anchor plane. Use :func:`fit_metric_depth` there.

    Returns ``(rescaled_depth, factor)``.
    """
    if depth.shape != wall_mask.shape:
        raise ValueError("wall mask must match the depth map's shape")
    selected = depth[wall_mask.astype(bool)]
    selected = selected[np.isfinite(selected) & (selected > 0)]
    if selected.size == 0:
        raise ValueError("the wall isn't visible in the depth map")
    # Median, not mean: a few pixels of the sofa in front of the wall must not
    # drag the scale factor.
    factor = float(expected_distance / np.median(selected))
    if not np.isfinite(factor) or factor <= 0:
        raise ValueError("depth rescale produced a nonsensical factor")
    return depth * factor, factor


def back_project(
    pixels: np.ndarray,
    depth_values: np.ndarray,
    intrinsics: np.ndarray,
    pose: Pose,
) -> np.ndarray:
    """Pixels + metric depth → world points.

    ``pixels`` is ``(n, 2)`` in image coordinates with the origin top-left, the
    convention every mask in this pipeline uses.
    """
    fx, fy = intrinsics[0, 0], intrinsics[1, 1]
    cx, cy = intrinsics[0, 2], intrinsics[1, 2]
    x = (pixels[:, 0] - cx) / fx
    # Image y grows downward, camera y grows upward.
    y = -(pixels[:, 1] - cy) / fy
    directions = np.stack([x, y, -np.ones_like(x)], axis=1)
    camera_points = directions * depth_values[:, None]
    return pose.to_world(camera_points)
