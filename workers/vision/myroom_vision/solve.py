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


def rescale_depth(
    depth: np.ndarray,
    *,
    wall_mask: np.ndarray,
    expected_distance: float,
) -> tuple[np.ndarray, float]:
    """Scale a monocular depth map so the tagged wall lands where the plan says.

    This is the correction step that makes the pipeline plan-accurate rather
    than merely plausible: the model's depth is consistent but arbitrarily
    scaled, and the plan supplies the one true distance it can be pinned to.

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
