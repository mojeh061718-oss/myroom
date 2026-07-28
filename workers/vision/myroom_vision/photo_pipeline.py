"""Photograph → furniture, on CPU, through a hosted model (docs/05 §3–§5).

This is the end-to-end path for a deployment with a Bedrock account and no GPU.
It is deliberately runnable on its own:

    python -m myroom_vision.photo_pipeline --plan plan.json --wall A --photo wall-a.jpg

so the whole thing can be tried against one real photo before any of it is
wired into a hosted API.

The stages it replaces, and how:

    1  detect & segment  →  boxes from a multimodal model, no masks
    2  camera & scale    →  pose from the tagged wall's known rectangle
    3  measure           →  rays onto the room's own floor and wall planes

Everything else — matching against the catalog, assembling the scene — is
unchanged, because this emits the same measured-object shape stage 3 already
does.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from .bedrock import BedrockUnavailable, ImageReading, UnreadableReading, read_photo
from .detect import TAXONOMY_JSON
from .place import (
    PlacedBox,
    Unlocalizable,
    WallFrame,
    place_floor_object,
    place_wall_object,
    pose_from_wall_quad,
)
from .solve import intrinsics_from_exif

DEFAULT_CEILING_HEIGHT = 2.4


class PlanUnusable(ValueError):
    """The plan does not describe the wall this photo was tagged to."""


def image_size(data: bytes) -> tuple[int, int]:
    """Pixel size of a JPEG or PNG, without an image library.

    Stage 1 needs the size to turn the model's fractional coordinates into
    pixels, and that is the *only* thing it needs from the file. Reading two
    headers here keeps a whole imaging dependency — and its licence review — out
    of the CPU worker.
    """
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        width, height = struct.unpack(">II", data[16:24])
        return int(width), int(height)
    if data[:2] == b"\xff\xd8":
        offset = 2
        while offset + 9 < len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            marker = data[offset + 1]
            # SOF0–SOF15, excluding the four that are not frame headers.
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                height, width = struct.unpack(">HH", data[offset + 5 : offset + 9])
                return int(width), int(height)
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                offset += 2
                continue
            (segment,) = struct.unpack(">H", data[offset + 2 : offset + 4])
            offset += 2 + segment
    raise ValueError("photo is neither a JPEG nor a PNG")


@lru_cache(maxsize=1)
def _catalog_proportions() -> dict[str, dict[str, float]]:
    """Default width/height/depth per category, for the extents a photo can't see."""
    data = json.loads(TAXONOMY_JSON.read_text())
    return {
        entry["id"]: {
            "w": float(entry["defaultSize"]["w"]),
            "h": float(entry["defaultSize"]["h"]),
            "d": float(entry["defaultSize"]["d"]),
            "support": entry.get("support", "floor"),
        }
        for entry in data
    }


@dataclass(frozen=True)
class MeasuredObject:
    category: str
    confidence: float
    box: PlacedBox

    def as_dict(self) -> dict[str, object]:
        payload = dict(self.box.as_dict())
        payload["category"] = self.category
        payload["confidence"] = self.confidence
        payload["measured"] = list(self.box.measured)
        return payload


def wall_frame(plan: dict, label: str) -> tuple[WallFrame, float]:
    """The tagged wall's world frame, and the ceiling height to use with it.

    Plan coordinates are (x, y); world is (x, −z). The inward normal comes from
    the polygon's winding, so it points into the room whichever way the user
    happened to draw it.
    """
    vertices = {v["id"]: (float(v["x"]), float(v["y"])) for v in plan.get("vertices", [])}
    walls = plan.get("walls", [])
    match = next((w for w in walls if w.get("label") == label or w.get("id") == label), None)
    if match is None:
        known = ", ".join(sorted(str(w.get("label", w.get("id"))) for w in walls)) or "none"
        raise PlanUnusable(f"the plan has no wall {label!r} (it has: {known})")
    try:
        start_plan, end_plan = vertices[match["start"]], vertices[match["end"]]
    except KeyError as error:
        raise PlanUnusable(f"wall {label!r} refers to missing vertex {error}") from error

    ring = [vertices[w["start"]] for w in walls if w.get("start") in vertices]
    signed = 0.0
    for index, (x0, y0) in enumerate(ring):
        x1, y1 = ring[(index + 1) % len(ring)]
        signed += x0 * y1 - x1 * y0
    counter_clockwise = signed > 0

    dx, dy = end_plan[0] - start_plan[0], end_plan[1] - start_plan[1]
    length = float(np.hypot(dx, dy))
    if length <= 0:
        raise PlanUnusable(f"wall {label!r} has zero length")
    # Interior is to the left of each directed edge of a counter-clockwise ring.
    normal_plan = (-dy / length, dx / length) if counter_clockwise else (dy / length, -dx / length)

    frame = WallFrame(
        start=(start_plan[0], -start_plan[1]),
        end=(end_plan[0], -end_plan[1]),
        inward=(normal_plan[0], -normal_plan[1]),
    )
    return frame, float(plan.get("ceilingHeight") or DEFAULT_CEILING_HEIGHT)


def measure_reading(
    reading: ImageReading,
    *,
    plan: dict,
    wall_label: str,
    size: tuple[int, int],
    focal_35mm: float | None = None,
) -> tuple[list[MeasuredObject], list[str]]:
    """Turn one photo's reading into measured objects, plus what went unused."""
    notes = list(reading.notes)
    frame, ceiling = wall_frame(plan, wall_label)
    if reading.wall_quad is None:
        notes.append(
            f"photo of wall {wall_label}: the wall's corners weren't all visible, "
            "so nothing in it could be located"
        )
        return [], notes

    intrinsics = intrinsics_from_exif(size[0], size[1], focal_35mm)
    try:
        pose = pose_from_wall_quad(
            np.asarray(reading.wall_quad),
            wall_width=frame.width,
            wall_height=ceiling,
            intrinsics=intrinsics,
            image_size=size,
        )
    except Unlocalizable as error:
        notes.append(f"photo of wall {wall_label}: couldn't be located ({error})")
        return [], notes

    proportions = _catalog_proportions()
    measured: list[MeasuredObject] = []
    for detection in reading.detections:
        defaults = proportions.get(detection.category)
        if defaults is None:
            continue
        try:
            if defaults["support"] == "wall":
                box = place_wall_object(
                    detection.box, pose=pose, intrinsics=intrinsics, wall=frame,
                    thickness=defaults["d"],
                )
            else:
                box = place_floor_object(
                    detection.box, pose=pose, intrinsics=intrinsics, wall=frame,
                    depth_over_width=defaults["d"] / max(defaults["w"], 1e-6),
                )
        except Unlocalizable as error:
            notes.append(f"{detection.category}: seen but not placeable ({error})")
            continue
        measured.append(
            MeasuredObject(category=detection.category, confidence=detection.confidence, box=box)
        )
    return measured, notes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--plan", required=True, type=Path, help="room plan JSON (packages/schema)")
    parser.add_argument("--photo", required=True, type=Path, action="append",
                        help="a photo; repeat once per wall")
    parser.add_argument("--wall", required=True, action="append",
                        help="the wall label each photo was tagged to, in the same order")
    parser.add_argument("--focal-35mm", type=float, default=None,
                        help="35 mm-equivalent focal length, if the photo has no EXIF")
    args = parser.parse_args(argv)

    if len(args.photo) != len(args.wall):
        parser.error("give one --wall per --photo")

    plan = json.loads(args.plan.read_text())
    objects: list[MeasuredObject] = []
    notes: list[str] = []
    for photo_path, wall_label in zip(args.photo, args.wall):
        data = photo_path.read_bytes()
        size = image_size(data)
        media = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpeg"
        try:
            reading = read_photo(data, media_type=media, wall_tag=wall_label, image_size=size)
        except (BedrockUnavailable, UnreadableReading) as error:
            print(f"{photo_path.name}: {error}", file=sys.stderr)
            notes.append(f"{photo_path.name}: {error}")
            continue
        found, photo_notes = measure_reading(
            reading, plan=plan, wall_label=wall_label, size=size, focal_35mm=args.focal_35mm
        )
        objects.extend(found)
        notes.extend(photo_notes)

    json.dump(
        {"objects": [o.as_dict() for o in objects], "notes": notes, "tier": "photo"},
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
