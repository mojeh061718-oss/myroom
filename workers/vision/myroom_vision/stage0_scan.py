"""Stage 0 — scan parse (docs/05 §2).

Input formats in order of value: RoomPlan JSON (already parametric), then mesh /
point-cloud formats that need the room recovered from geometry. Output is a
``scan-parse`` artifact: refined wall lines, a ceiling height, seed object boxes,
and the disagreements a human should look at.

A scan we cannot read is not an error: ``parsed: false`` carries the reason and
the pipeline proceeds photo-only (docs/05 §8).
"""

from __future__ import annotations

import json
from typing import Any

import numpy as np

from . import pointcloud, register
from .roomplan import ParsedScan, ScanObject, ScanWall, looks_like_roomplan, parse_roomplan
from .schemas import validate


#: Upload sniffing (apps/api/src/uploads/magic.ts) names a bare RoomPlan
#: sidecar by its container — "json" — while the scan-parse contract names it by
#: what it is. Without this mapping a RoomPlan export parses correctly and then
#: fails its own output validation, because "json" is not in the schema's enum.
_FORMAT_ALIASES = {"json": "roomplan-json"}


def canonical_format(fmt: str) -> str:
    """The contract's name for an input format (packages/schema ScanFormat)."""
    return _FORMAT_ALIASES.get(fmt, fmt)


def _failed(fmt: str, reason: str) -> dict[str, Any]:
    return {
        "format": canonical_format(fmt),
        "parsed": False,
        "failure": reason,
        "walls": [],
        "ceilingHeight": None,
        "seedBoxes": [],
        "disagreements": [],
        "silhouette": [],
    }


def _wall_json(wall: ScanWall) -> dict[str, Any]:
    return {
        "start": {"x": wall.start[0], "y": wall.start[1]},
        "end": {"x": wall.end[0], "y": wall.end[1]},
        "height": wall.height,
    }


def parse_scan(
    data: bytes,
    fmt: str,
    plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Parse ``data`` and, when a plan is supplied, register it against the plan.

    ``plan`` is a RoomPlan document (docs/07 §2). Its vertex loop and wall list
    give this stage both the registration target and the walls to compare
    lengths against.
    """
    try:
        scan = _extract(data, fmt)
    except Exception as error:  # noqa: BLE001 - the reason is user-facing copy
        return validate("scan-parse", _failed(fmt, str(error)[:200]))

    if not scan.walls:
        return validate("scan-parse", _failed(fmt, "no walls could be found in the scan"))

    walls = scan.walls
    disagreements: list[dict[str, Any]] = []
    silhouette: list[list[float]] = []

    if plan is not None:
        loop = _plan_loop(plan)
        drawn = _plan_walls(plan)
        registration = register.register_walls(walls, loop) if loop else None
        if registration is not None:
            walls = [
                ScanWall(
                    tuple(registration.apply(np.asarray([w.start]))[0]),
                    tuple(registration.apply(np.asarray([w.end]))[0]),
                    w.height,
                )
                for w in scan.walls
            ]
            disagreements = [
                {
                    "wallId": d.wall_id,
                    "wallLabel": d.wall_label,
                    "drawnLength": d.drawn_length,
                    "scannedLength": d.scanned_length,
                    "delta": d.delta,
                    "needsReview": d.needs_review,
                }
                for d in register.compare_lengths(drawn, scan.walls, registration)
                # The schema requires positive lengths; a degenerate match is
                # not a disagreement worth showing anyone.
                if d.drawn_length > 0 and d.scanned_length > 0
            ]
        silhouette = [[round(float(p[0]), 3), round(float(p[1]), 3)] for w in walls for p in (w.start, w.end)]

    seed_boxes = [
        {
            "category": obj.category,
            "position": {"x": obj.position[0], "y": obj.position[1], "z": obj.position[2]},
            "rotationY": obj.rotation_y,
            "size": {"w": obj.size[0], "h": obj.size[1], "d": obj.size[2]},
        }
        for obj in scan.objects
        if min(obj.size) > 0
    ]

    return validate(
        "scan-parse",
        {
            "format": canonical_format(fmt),
            "parsed": True,
            "failure": None,
            "walls": [_wall_json(w) for w in walls],
            "ceilingHeight": scan.ceiling_height,
            "seedBoxes": seed_boxes,
            "disagreements": disagreements,
            "silhouette": silhouette,
        },
    )


def _extract(data: bytes, fmt: str) -> ParsedScan:
    if fmt in {"roomplan-json", "json"}:
        doc = json.loads(data.decode("utf-8"))
        if not looks_like_roomplan(doc):
            raise ValueError("this JSON isn't a RoomPlan export")
        return parse_roomplan(doc)

    if fmt == "ply":
        points = pointcloud.read_ply(data)
        return _from_points(points)

    raise ValueError(f"{fmt} scans aren't supported yet")


def _from_points(points: np.ndarray) -> ParsedScan:
    if len(points) < 100:
        raise ValueError("the scan has too few points to find walls in")
    floor = pointcloud.floor_height(points)
    ceiling = float(np.percentile(points[:, 1], 98)) - floor
    planes = pointcloud.fit_vertical_planes(points)
    walls = pointcloud.planes_to_walls(points, planes, ceiling if ceiling > 1.5 else None)
    scan = ParsedScan(walls=walls, ceiling_height=ceiling if ceiling > 1.5 else None)
    # Object clusters become seed boxes with no category: the photos supply the
    # class, the scan supplies the size (docs/05 §5).
    inliers = np.concatenate([p.inliers for p in planes]) if planes else None
    for lo, hi in pointcloud.cluster_above_floor(points, floor=floor, wall_inliers=inliers):
        size = hi - lo
        # Furniture-scale only: a 5 cm blob is noise and a 5 m one is the room.
        if min(size) < 0.1 or max(size) > 4.0:
            continue
        centre = (lo + hi) / 2
        scan.objects.append(
            ScanObject(
                category=None,
                position=(float(centre[0]), float(lo[1]), float(centre[2])),
                rotation_y=0.0,
                size=(float(size[0]), float(size[1]), float(size[2])),
            )
        )
    return scan


def _plan_loop(plan: dict[str, Any]) -> list[tuple[float, float]]:
    vertices = {v["id"]: (float(v["x"]), float(v["y"])) for v in plan.get("vertices", [])}
    walls = plan.get("walls", [])
    if not walls:
        return []
    loop: list[tuple[float, float]] = []
    nxt = {w["start"]: w["end"] for w in walls}
    current = walls[0]["start"]
    for _ in range(len(walls)):
        if current not in vertices:
            return []
        loop.append(vertices[current])
        current = nxt.get(current)
        if current is None:
            return []
    return loop if current == walls[0]["start"] else []


def _plan_walls(plan: dict[str, Any]) -> list[dict[str, Any]]:
    vertices = {v["id"]: (float(v["x"]), float(v["y"])) for v in plan.get("vertices", [])}
    out = []
    for wall in plan.get("walls", []):
        start = vertices.get(wall.get("start"))
        end = vertices.get(wall.get("end"))
        if start is None or end is None:
            continue
        out.append({"id": wall.get("id"), "label": wall.get("label"), "start": start, "end": end})
    return out
