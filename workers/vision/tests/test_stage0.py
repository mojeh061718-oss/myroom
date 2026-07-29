"""Stage 0 — scan parse and registration (docs/05 §2)."""

from __future__ import annotations

import json
import struct

import numpy as np
import pytest

from myroom_vision import pointcloud, register, stage0_scan
from myroom_vision.roomplan import parse_roomplan
from myroom_vision.schemas import is_valid


def transform(position, yaw=0.0):
    """A RoomPlan-style column-major 4×4 with a Y rotation."""
    c, s = np.cos(yaw), np.sin(yaw)
    m = np.array(
        [
            [c, 0.0, s, position[0]],
            [0.0, 1.0, 0.0, position[1]],
            [-s, 0.0, c, position[2]],
            [0.0, 0.0, 0.0, 1.0],
        ]
    )
    return m.T.ravel().tolist()


def roomplan_doc():
    """A 4 m × 3 m room: two walls along X, two along Z, one sofa."""
    return {
        "walls": [
            {"transform": transform((0.0, 1.22, -1.5)), "dimensions": [4.0, 2.44, 0.1]},
            {"transform": transform((0.0, 1.22, 1.5)), "dimensions": [4.0, 2.44, 0.1]},
            {"transform": transform((-2.0, 1.22, 0.0), np.pi / 2), "dimensions": [3.0, 2.44, 0.1]},
            {"transform": transform((2.0, 1.22, 0.0), np.pi / 2), "dimensions": [3.0, 2.44, 0.1]},
        ],
        "objects": [
            {
                "transform": transform((0.5, 0.4, -1.0)),
                "dimensions": [2.1, 0.8, 0.9],
                "category": "sofa",
            },
            {
                "transform": transform((1.5, 0.5, 1.0)),
                "dimensions": [1.2, 1.0, 0.4],
                "category": "unheardOf",
            },
        ],
    }


def test_roomplan_walls_land_in_plan_coordinates():
    scan = parse_roomplan(roomplan_doc())
    assert len(scan.walls) == 4
    lengths = sorted(round(w.length, 3) for w in scan.walls)
    assert lengths == [3.0, 3.0, 4.0, 4.0]
    assert scan.ceiling_height == pytest.approx(2.44)


def test_roomplan_objects_map_to_our_taxonomy_or_stay_unnamed():
    scan = parse_roomplan(roomplan_doc())
    categories = [o.category for o in scan.objects]
    assert "sofa" in categories
    # An unmapped RoomPlan class keeps its box but not a guessed name.
    assert None in categories


def test_scan_parse_emits_a_schema_valid_artifact():
    plan = {
        "vertices": [
            {"id": "a", "x": -2.0, "y": -1.5},
            {"id": "b", "x": 2.0, "y": -1.5},
            {"id": "c", "x": 2.0, "y": 1.5},
            {"id": "d", "x": -2.0, "y": 1.5},
        ],
        "walls": [
            {"id": "w1", "label": "A", "start": "a", "end": "b"},
            {"id": "w2", "label": "B", "start": "b", "end": "c"},
            {"id": "w3", "label": "C", "start": "c", "end": "d"},
            {"id": "w4", "label": "D", "start": "d", "end": "a"},
        ],
    }
    artifact = stage0_scan.parse_scan(json.dumps(roomplan_doc()).encode(), "roomplan-json", plan)
    assert artifact["parsed"] is True
    assert is_valid("scan-parse", artifact)
    assert len(artifact["walls"]) == 4
    assert artifact["ceilingHeight"] == pytest.approx(2.44)


def test_an_unreadable_scan_is_reported_not_raised():
    artifact = stage0_scan.parse_scan(b"{}", "roomplan-json")
    assert artifact["parsed"] is False
    assert "RoomPlan" in artifact["failure"]
    assert is_valid("scan-parse", artifact)

    artifact = stage0_scan.parse_scan(b"\x00\x01", "e57")
    assert artifact["parsed"] is False
    assert is_valid("scan-parse", artifact)


# --- registration ------------------------------------------------------------


def rectangle(width=4.0, depth=3.0):
    return [(-width / 2, -depth / 2), (width / 2, -depth / 2), (width / 2, depth / 2), (-width / 2, depth / 2)]


def walls_of(loop):
    from myroom_vision.roomplan import ScanWall

    return [ScanWall(loop[i], loop[(i + 1) % len(loop)]) for i in range(len(loop))]


def test_registration_recovers_a_known_rotation_and_translation():
    loop = rectangle()
    angle = np.deg2rad(37.0)
    c, s = np.cos(angle), np.sin(angle)
    rotation = np.array([[c, -s], [s, c]])
    offset = np.array([1.3, -0.8])
    scanned = [tuple(np.asarray(p) @ rotation.T + offset) for p in loop]

    result = register.register_walls(walls_of(scanned), loop)
    assert result is not None
    # Sub-centimetre agreement after alignment.
    assert result.residual < 0.01
    moved = result.apply(np.asarray(scanned))
    for point in moved:
        assert min(np.linalg.norm(point - np.asarray(v)) for v in loop) < 0.02


def test_disagreements_flag_only_the_big_ones():
    drawn_loop = rectangle(4.0, 3.0)
    # The scan says the long walls are 4.6 m — 60 cm more than drawn.
    scanned_loop = rectangle(4.6, 3.0)
    drawn = [
        {"id": f"w{i}", "label": "ABCD"[i], "start": drawn_loop[i], "end": drawn_loop[(i + 1) % 4]}
        for i in range(4)
    ]
    registration = register.register_walls(walls_of(scanned_loop), drawn_loop)
    assert registration is not None
    disagreements = register.compare_lengths(drawn, walls_of(scanned_loop), registration)
    by_label = {d.wall_label: d for d in disagreements}
    long_walls = [d for d in disagreements if d.drawn_length == pytest.approx(4.0)]
    assert long_walls, by_label
    assert all(d.needs_review for d in long_walls)
    short_walls = [d for d in disagreements if d.drawn_length == pytest.approx(3.0)]
    assert all(not d.needs_review for d in short_walls)


# --- point clouds ------------------------------------------------------------


def ascii_ply(points: np.ndarray) -> bytes:
    header = (
        "ply\nformat ascii 1.0\n"
        f"element vertex {len(points)}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "end_header\n"
    )
    body = "\n".join(f"{x} {y} {z}" for x, y, z in points)
    return (header + body + "\n").encode()


def binary_ply(points: np.ndarray) -> bytes:
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {len(points)}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "end_header\n"
    ).encode()
    body = b"".join(struct.pack("<3f", *p) for p in points)
    return header + body


def room_cloud(width=4.0, depth=3.0, height=2.44, per_wall=400):
    rng = np.random.default_rng(3)
    parts = []
    for axis, extent, offset in (
        (0, width, -depth / 2),
        (0, width, depth / 2),
    ):
        x = rng.uniform(-width / 2, width / 2, per_wall)
        y = rng.uniform(0.1, height, per_wall)
        z = np.full(per_wall, offset)
        parts.append(np.stack([x, y, z], axis=1))
    for offset in (-width / 2, width / 2):
        z = rng.uniform(-depth / 2, depth / 2, per_wall)
        y = rng.uniform(0.1, height, per_wall)
        x = np.full(per_wall, offset)
        parts.append(np.stack([x, y, z], axis=1))
    # A floor, and a sofa-sized block sitting on it.
    floor = np.stack(
        [
            rng.uniform(-width / 2, width / 2, per_wall),
            np.zeros(per_wall),
            rng.uniform(-depth / 2, depth / 2, per_wall),
        ],
        axis=1,
    )
    # A sofa-sized block, densely sampled the way a real scan samples a solid
    # surface — a sparse block wouldn't be connected at any voxel size.
    block = np.stack(
        [
            rng.uniform(-0.9, 0.9, 4000),
            rng.uniform(0.05, 0.8, 4000),
            rng.uniform(-1.2, -0.7, 4000),
        ],
        axis=1,
    )
    return np.vstack([*parts, floor, block])


def test_ply_reads_both_encodings_identically():
    points = np.round(room_cloud(per_wall=50), 3)
    from_ascii = pointcloud.read_ply(ascii_ply(points))
    from_binary = pointcloud.read_ply(binary_ply(points))
    assert from_ascii.shape == points.shape
    np.testing.assert_allclose(from_ascii, from_binary, atol=1e-3)


def test_ply_rejects_what_it_cannot_read():
    with pytest.raises(pointcloud.PlyError):
        pointcloud.read_ply(b"not a ply at all")


def test_walls_are_recovered_from_a_point_cloud():
    points = room_cloud()
    planes = pointcloud.fit_vertical_planes(points)
    walls = pointcloud.planes_to_walls(points, planes, 2.44)
    lengths = sorted(w.length for w in walls)
    assert len(walls) == 4, [round(w.length, 2) for w in walls]
    # Within 30 cm of the true 3 m and 4 m walls. A segment is only as long as
    # its sampled inliers: the ends of a randomly sampled wall fall short of the
    # corner, and the corner points themselves go to whichever plane RANSAC
    # fitted first. Both are sampling artifacts, not misplaced walls.
    assert lengths[0] == pytest.approx(3.0, abs=0.3)
    assert lengths[1] == pytest.approx(3.0, abs=0.3)
    assert lengths[2] == pytest.approx(4.0, abs=0.3)
    assert lengths[3] == pytest.approx(4.0, abs=0.3)


def test_clustering_finds_the_object_and_not_the_walls():
    points = room_cloud()
    planes = pointcloud.fit_vertical_planes(points)
    inliers = np.concatenate([p.inliers for p in planes])
    boxes = pointcloud.cluster_above_floor(points, floor=0.0, wall_inliers=inliers)
    sizes = [hi - lo for lo, hi in boxes]
    assert any(1.5 < s[0] < 2.1 and 0.6 < s[1] < 0.9 for s in sizes), sizes


def test_a_roomplan_json_upload_validates_against_its_own_contract():
    """Regression: `magic.ts` names a bare RoomPlan sidecar "json", but the
    scan-parse enum only knows "roomplan-json". Emitting the sniffed name made
    a successfully parsed scan fail its own output validation."""
    from myroom_vision.stage0_scan import canonical_format

    assert canonical_format("json") == "roomplan-json"
    # Everything the schema already names passes through untouched.
    for fmt in ("roomplan-json", "usdz", "ply", "glb", "e57", "las"):
        assert canonical_format(fmt) == fmt


def test_every_format_stage0_emits_is_in_the_schema_enum():
    import json
    from pathlib import Path

    from myroom_vision.stage0_scan import _failed, canonical_format
    from myroom_vision.schemas import validate

    schema = json.loads(
        (Path(__file__).resolve().parents[3] / "packages/schema/json/scan-parse.schema.json").read_text()
    )
    allowed = set(schema["definitions"]["scan-parse"]["properties"]["format"]["enum"])

    # Every format the upload layer can hand us must survive canonicalisation
    # into something the contract accepts.
    for sniffed in ("json", "roomplan-json", "ply", "glb", "e57", "las", "usdz"):
        assert canonical_format(sniffed) in allowed, sniffed
        validate("scan-parse", _failed(sniffed, "unreadable"))


def test_roomplan_object_yaw_is_not_a_quarter_turn_out():
    """Regression: the worker read yaw off column 0 of the transform.

    For a rotation of θ about Y, column 0 is (cos θ, 0, −sin θ) and column 2 is
    (sin θ, 0, cos θ), so atan2 over column 0 returns θ + π/2. The TypeScript
    parser was fixed first; this is the same bug on the worker side, which is
    the authoritative Stage 0 input.

    `test_stages.py` could not catch it: its yaw assertion is modulo 90°, which
    is exactly blind to this offset.
    """
    import math

    import numpy as np

    from myroom_vision.roomplan import parse_roomplan

    def doc_with_yaw(theta: float) -> dict:
        c, s = math.cos(theta), math.sin(theta)
        # Column-major 4x4, flattened the way RoomPlan exports it.
        transform = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0.5, 0.4, -1.2, 1]
        wall = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, -2, 1]
        return {
            "walls": [{"transform": wall, "dimensions": [4.0, 2.44, 0.1]}],
            "objects": [
                {"category": "sofa", "transform": transform, "dimensions": [2.1, 0.8, 0.9]}
            ],
        }

    for theta in (0.0, math.pi / 6, math.pi / 2, math.pi, -2.443):
        parsed = parse_roomplan(doc_with_yaw(theta))
        assert parsed.objects, f"no object parsed at theta={theta}"
        got = parsed.objects[0].rotation_y
        delta = (got - theta + math.pi) % (2 * math.pi) - math.pi
        assert abs(delta) < 1e-6, (
            f"theta={math.degrees(theta):.1f}° -> {math.degrees(got):.1f}° "
            f"(off by {math.degrees(delta):.1f}°)"
        )
        np.testing.assert_allclose(parsed.objects[0].size, (2.1, 0.8, 0.9), atol=1e-9)
