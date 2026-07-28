"""The CPU photo path end to end, minus the network (docs/05 §3–§5)."""

from __future__ import annotations

import json
import math
import struct

import numpy as np
import pytest

from myroom_vision.bedrock import ImageReading, parse_reading
from myroom_vision.photo_pipeline import (
    PlanUnusable,
    image_size,
    measure_reading,
    wall_frame,
)

SIZE = (1600, 1200)

# A 4 m × 3 m room drawn clockwise in plan coordinates, walls A..D.
PLAN = {
    "schemaVersion": 1,
    "id": "plan-1",
    "units": "m",
    "ceilingHeight": 2.5,
    "vertices": [
        {"id": "v0", "x": 0.0, "y": 0.0},
        {"id": "v1", "x": 4.0, "y": 0.0},
        {"id": "v2", "x": 4.0, "y": 3.0},
        {"id": "v3", "x": 0.0, "y": 3.0},
    ],
    "walls": [
        {"id": "w0", "label": "A", "start": "v0", "end": "v1", "thickness": 0.1},
        {"id": "w1", "label": "B", "start": "v1", "end": "v2", "thickness": 0.1},
        {"id": "w2", "label": "C", "start": "v2", "end": "v3", "thickness": 0.1},
        {"id": "w3", "label": "D", "start": "v3", "end": "v0", "thickness": 0.1},
    ],
}


def test_jpeg_and_png_sizes_are_read_without_an_image_library():
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + struct.pack(">II", 640, 480)
    assert image_size(png) == (640, 480)

    jpeg = b"\xff\xd8" + b"\xff\xe0" + struct.pack(">H", 16) + b"\x00" * 14
    jpeg += b"\xff\xc0" + struct.pack(">H", 17) + b"\x08" + struct.pack(">HH", 480, 640) + b"\x00" * 8
    assert image_size(jpeg) == (640, 480)

    with pytest.raises(ValueError):
        image_size(b"GIF89a not really")


def test_the_inward_normal_points_into_the_room_whichever_way_it_was_drawn():
    frame, ceiling = wall_frame(PLAN, "A")
    assert ceiling == pytest.approx(2.5)
    assert frame.width == pytest.approx(4.0)
    # Wall A runs along plan y = 0 with the room at plan y > 0, i.e. world z < 0.
    inside_x, inside_z = frame.to_world(2.0, 1.0)
    assert inside_x == pytest.approx(2.0)
    assert inside_z == pytest.approx(-1.0)

    reversed_plan = dict(PLAN, walls=[dict(w) for w in reversed(PLAN["walls"])])
    for wall in reversed_plan["walls"]:
        wall["start"], wall["end"] = wall["end"], wall["start"]
    flipped, _ = wall_frame(reversed_plan, "A")
    # Drawn the other way round, wall A's own direction flips, but "into the
    # room" must still be into the room.
    assert flipped.to_world(2.0, 1.0)[1] == pytest.approx(-1.0)


def test_an_unknown_wall_label_says_which_walls_exist():
    with pytest.raises(PlanUnusable) as error:
        wall_frame(PLAN, "Z")
    assert "A, B, C, D" in str(error.value)


def test_a_missing_ceiling_height_falls_back_rather_than_failing():
    _, ceiling = wall_frame({**PLAN, "ceilingHeight": None}, "A")
    assert ceiling == pytest.approx(2.4)


#: A phone's wide lens, held at chest height, backed up against the far wall —
#: the geometry guided capture actually asks for (docs/01 §6).
FOCAL_35MM = 18.0


def _synthetic_reading(objects):
    """A reading as if a model had looked at wall A from across the room."""
    rotation = np.array([[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]])
    centre = np.array([2.0, 1.2, 2.8])
    from myroom_vision.solve import intrinsics_from_exif

    intrinsics = intrinsics_from_exif(*SIZE, FOCAL_35MM)

    def project(point):
        camera = rotation @ (np.asarray(point, dtype=float) - centre)
        image = intrinsics @ camera
        return float(image[0] / image[2]) / SIZE[0], float(image[1] / image[2]) / SIZE[1]

    corners = {
        "bottom_left": project((0.0, 0.0, 0.0)),
        "bottom_right": project((4.0, 0.0, 0.0)),
        "top_right": project((4.0, 2.5, 0.0)),
        "top_left": project((0.0, 2.5, 0.0)),
    }
    return json.dumps({"wall": {k: list(v) for k, v in corners.items()}, "objects": objects}), project


def test_a_photographed_sofa_lands_in_the_room_at_its_real_size():
    reply, project = _synthetic_reading([])
    # A 2.1 m sofa against wall A, 0.92 m deep, 0.83 m tall.
    face = [(0.95, 0.0, 0.92), (3.05, 0.0, 0.92), (3.05, 0.83, 0.92), (0.95, 0.83, 0.92)]
    pixels = [project(p) for p in face]
    xs = [p[0] for p in pixels]
    ys = [p[1] for p in pixels]
    payload = json.loads(reply)
    payload["objects"] = [
        {"label": "sofa", "confidence": 0.95,
         "box": [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)], "support": "floor"}
    ]

    reading = parse_reading(json.dumps(payload), image_size=SIZE, wall_tag="A")
    measured, notes = measure_reading(
        reading, plan=PLAN, wall_label="A", size=SIZE, focal_35mm=FOCAL_35MM
    )

    assert notes == []
    assert len(measured) == 1
    sofa = measured[0]
    assert sofa.category == "sofa"
    assert sofa.box.size[0] == pytest.approx(2.1, abs=0.02)
    assert sofa.box.size[1] == pytest.approx(0.83, abs=0.02)
    # Centred on the wall, sitting on the floor, inside the room (world z < 0).
    assert sofa.box.position[0] == pytest.approx(2.0, abs=0.03)
    assert sofa.box.position[1] == pytest.approx(0.0)
    assert -1.0 < sofa.box.position[2] < 0.0
    # Squared up to the wall it was seen against, facing into the room.
    assert math.cos(sofa.box.rotation_y) == pytest.approx(0.0, abs=1e-9)


def test_a_photo_that_cannot_be_located_reports_it_and_places_nothing():
    reading = ImageReading(detections=(), wall_quad=None, notes=())
    measured, notes = measure_reading(reading, plan=PLAN, wall_label="A", size=SIZE)

    assert measured == []
    assert any("weren't all visible" in note for note in notes)


def test_an_unplaceable_detection_is_reported_not_dropped_silently():
    """A box whose base is above the horizon can't reach the floor — say so."""
    reply, _ = _synthetic_reading([])
    payload = json.loads(reply)
    payload["objects"] = [
        {"label": "sofa", "confidence": 0.9, "box": [0.4, 0.01, 0.2, 0.05], "support": "floor"}
    ]
    reading = parse_reading(json.dumps(payload), image_size=SIZE, wall_tag="A")

    measured, notes = measure_reading(
        reading, plan=PLAN, wall_label="A", size=SIZE, focal_35mm=FOCAL_35MM
    )

    assert measured == []
    assert any("not placeable" in note for note in notes)
