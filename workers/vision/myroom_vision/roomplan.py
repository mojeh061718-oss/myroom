"""Apple RoomPlan export parsing — the gold Stage 0 input (docs/05 §2).

A ``CapturedRoom`` JSON export is already parametric and metric: walls, doors,
windows and detected objects each carry a 4×4 transform and a size. That is
exactly the shape we want, so this parser is a coordinate conversion and a
category mapping, not an estimation problem.

RoomPlan is Y-up, right-handed, metres. Our plan frame is 2D with world
``(x, y, z)`` ↔ plan ``(x, −z)``, so a RoomPlan point maps to ``(X, −Z)``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

import numpy as np

#: RoomPlan's object categories → our taxonomy ids (packages/catalog).
#: Anything unmapped keeps ``None``: a seed box with an honest "something is
#: here, this size" beats one filed under a guessed class.
CATEGORY_MAP: dict[str, str] = {
    "bathtub": "bathtub",
    "bed": "bed",
    "chair": "dining-chair",
    "dishwasher": "dishwasher",
    "fireplace": "fireplace",
    "oven": "oven",
    "refrigerator": "refrigerator",
    "sink": "kitchen-sink",
    "sofa": "sofa",
    "storage": "cabinet",
    "stove": "range",
    "table": "dining-table",
    "television": "tv",
    "toilet": "toilet",
    "washerDryer": "washing-machine",
}


@dataclass
class ScanWall:
    """A wall segment in plan coordinates (metres)."""

    start: tuple[float, float]
    end: tuple[float, float]
    height: float | None = None

    @property
    def length(self) -> float:
        return float(np.hypot(self.end[0] - self.start[0], self.end[1] - self.start[1]))


@dataclass
class ScanObject:
    category: str | None
    #: world-space centre, Y-up metres
    position: tuple[float, float, float]
    rotation_y: float
    size: tuple[float, float, float]


@dataclass
class ParsedScan:
    walls: list[ScanWall] = field(default_factory=list)
    objects: list[ScanObject] = field(default_factory=list)
    ceiling_height: float | None = None


def _matrix(raw: Any) -> np.ndarray | None:
    """RoomPlan transforms are 16 column-major floats, sometimes nested 4×4."""
    if raw is None:
        return None
    values = np.asarray(raw, dtype=float).ravel()
    if values.size != 16:
        return None
    # simd_float4x4 serializes column-major; reshaping rows then transposing
    # gives the usual row-major convention.
    return values.reshape(4, 4).T


def _dimensions(raw: Any) -> tuple[float, float, float] | None:
    if raw is None:
        return None
    values = np.asarray(raw, dtype=float).ravel()
    if values.size < 3:
        return None
    return float(values[0]), float(values[1]), float(values[2])


def _iter_surfaces(doc: dict[str, Any], key: str) -> Iterable[dict[str, Any]]:
    value = doc.get(key)
    if isinstance(value, list):
        yield from (v for v in value if isinstance(v, dict))


def parse_roomplan(doc: dict[str, Any]) -> ParsedScan:
    """Parse a ``CapturedRoom`` JSON export into plan-space walls and objects."""
    scan = ParsedScan()
    heights: list[float] = []

    for wall in _iter_surfaces(doc, "walls"):
        matrix = _matrix(wall.get("transform"))
        dims = _dimensions(wall.get("dimensions"))
        if matrix is None or dims is None:
            continue
        width, height = dims[0], dims[1]
        centre = matrix[:3, 3]
        # A RoomPlan surface's local +X runs along the wall.
        along = matrix[:3, 0]
        norm = float(np.linalg.norm(along))
        if norm < 1e-9 or width <= 0:
            continue
        along = along / norm
        half = along * (width / 2.0)
        a = centre - half
        b = centre + half
        scan.walls.append(
            ScanWall(
                start=(float(a[0]), float(-a[2])),
                end=(float(b[0]), float(-b[2])),
                height=float(height) if height > 0 else None,
            )
        )
        if height > 0:
            heights.append(float(height))

    for obj in _iter_surfaces(doc, "objects"):
        matrix = _matrix(obj.get("transform"))
        dims = _dimensions(obj.get("dimensions"))
        if matrix is None or dims is None:
            continue
        centre = matrix[:3, 3]
        # Column 2 (the object's local +Z), not column 0. For a rotation of θ
        # about Y, column 0 is (cos θ, 0, −sin θ) and column 2 is
        # (sin θ, 0, cos θ), so reading column 0 returns
        # atan2(cos θ, −sin θ) = θ + π/2 — every scanned object a quarter-turn
        # out, and `merge_with_seed` then hands that yaw to boxes whose own
        # rotation `measure.py` computed correctly.
        #
        # Walls above read column 0 deliberately: a wall's length runs along
        # its own local +X. Same fix as packages/recon/src/scan.ts.
        forward = matrix[:3, 2]
        rotation_y = float(np.arctan2(forward[0], forward[2]))
        raw_category = obj.get("category")
        if isinstance(raw_category, dict):
            # Some exporters wrap the enum: {"storage": {...}}.
            raw_category = next(iter(raw_category), None)
        scan.objects.append(
            ScanObject(
                category=CATEGORY_MAP.get(str(raw_category), None),
                position=(float(centre[0]), float(centre[1]), float(centre[2])),
                rotation_y=rotation_y,
                size=(float(dims[0]), float(dims[1]), float(dims[2])),
            )
        )

    if heights:
        # The tallest wall is the room height; short walls are partitions or
        # half-walls and would understate the ceiling.
        scan.ceiling_height = float(np.max(heights))
    return scan


def looks_like_roomplan(doc: Any) -> bool:
    """Cheap sniff so the caller can pick a parser before committing to one."""
    return isinstance(doc, dict) and isinstance(doc.get("walls"), list)
