"""Pose recovery and object placement without a depth model (docs/05 §4–§5).

Every case here is synthetic *by construction*: a camera is placed, the scene is
projected through it with plain pinhole arithmetic, and the module is asked to
recover what we started from. That is the only way to test this honestly without
tape-measured rooms — it certifies the geometry, not the accuracy target.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from myroom_vision.place import (
    CameraPose,
    PlacedBox,
    Unlocalizable,
    WallFrame,
    floor_point,
    place_floor_object,
    pose_from_wall_quad,
)
from myroom_vision.solve import intrinsics_from_exif

IMAGE = (1600, 1200)
K = intrinsics_from_exif(*IMAGE)

# Camera looking straight at the wall: forward is −w, up is +v.
LOOKING_AT_WALL = np.array([[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]])


def project(point_wall_local, *, rotation, centre) -> tuple[float, float]:
    """Pinhole projection of a wall-local point, in pixels."""
    camera = rotation @ (np.asarray(point_wall_local, dtype=float) - np.asarray(centre, dtype=float))
    assert camera[2] > 0, "point is behind the camera"
    image = K @ camera
    return float(image[0] / image[2]), float(image[1] / image[2])


def wall_quad(width: float, height: float, *, rotation, centre) -> np.ndarray:
    """The wall's four corners, in the bottom-left → clockwise order."""
    corners = [(0.0, 0.0, 0.0), (width, 0.0, 0.0), (width, height, 0.0), (0.0, height, 0.0)]
    return np.array([project(c, rotation=rotation, centre=centre) for c in corners])


def test_pose_recovers_a_head_on_camera():
    centre = np.array([2.0, 1.5, 3.0])
    quad = wall_quad(4.0, 2.5, rotation=LOOKING_AT_WALL, centre=centre)

    pose = pose_from_wall_quad(quad, wall_width=4.0, wall_height=2.5, intrinsics=K, image_size=IMAGE)

    assert pose.centre == pytest.approx(centre, abs=1e-6)
    assert pose.rotation == pytest.approx(LOOKING_AT_WALL, abs=1e-6)


def test_pose_recovers_an_oblique_camera():
    # Yawed 25° and standing off to one side — the everyday case, not the ideal.
    yaw = math.radians(25.0)
    spin = np.array(
        [[math.cos(yaw), 0.0, math.sin(yaw)], [0.0, 1.0, 0.0], [-math.sin(yaw), 0.0, math.cos(yaw)]]
    )
    rotation = LOOKING_AT_WALL @ spin
    centre = np.array([1.2, 1.6, 3.5])
    quad = wall_quad(4.0, 2.5, rotation=rotation, centre=centre)

    pose = pose_from_wall_quad(quad, wall_width=4.0, wall_height=2.5, intrinsics=K, image_size=IMAGE)

    assert pose.centre == pytest.approx(centre, abs=1e-5)
    assert pose.rotation == pytest.approx(rotation, abs=1e-5)


def test_pose_survives_a_pixel_of_corner_error():
    """Corners come from a model, not a protractor. A pixel must not matter."""
    centre = np.array([2.0, 1.5, 3.0])
    quad = wall_quad(4.0, 2.5, rotation=LOOKING_AT_WALL, centre=centre)
    jitter = np.array([[1.0, -1.0], [-1.0, 1.0], [1.0, 1.0], [-1.0, -1.0]])

    pose = pose_from_wall_quad(
        quad + jitter, wall_width=4.0, wall_height=2.5, intrinsics=K, image_size=IMAGE
    )

    # A pixel of error at this distance is a few millimetres on the ground.
    assert pose.centre == pytest.approx(centre, abs=0.02)


def test_a_collinear_quad_is_refused_rather_than_guessed():
    flat = np.array([[100.0, 600.0], [1500.0, 600.0], [1500.0, 601.0], [100.0, 601.0]])
    with pytest.raises(Unlocalizable):
        pose_from_wall_quad(flat, wall_width=4.0, wall_height=2.5, intrinsics=K, image_size=IMAGE)


def test_corner_order_wound_the_wrong_way_is_refused():
    centre = np.array([2.0, 1.5, 3.0])
    quad = wall_quad(4.0, 2.5, rotation=LOOKING_AT_WALL, centre=centre)
    with pytest.raises(Unlocalizable):
        pose_from_wall_quad(
            quad[::-1], wall_width=4.0, wall_height=2.5, intrinsics=K, image_size=IMAGE
        )


def test_floor_rays_land_where_the_geometry_says():
    centre = np.array([2.0, 1.5, 3.0])
    pose = CameraPose(rotation=LOOKING_AT_WALL, centre=centre)
    target = (2.4, 0.0, 1.0)

    landed = floor_point(pose, project(target, rotation=LOOKING_AT_WALL, centre=centre), K)

    assert landed == pytest.approx(np.asarray(target), abs=1e-6)


def test_a_ray_above_the_horizon_never_reaches_the_floor():
    pose = CameraPose(rotation=LOOKING_AT_WALL, centre=np.array([2.0, 1.5, 3.0]))
    with pytest.raises(Unlocalizable):
        floor_point(pose, (800.0, 10.0), K)


def _front_face_box(centre_u, depth_from_wall, width, height, *, rotation, centre):
    """Axis-aligned pixel box around an object's visible front face."""
    corners = [
        (centre_u - width / 2, 0.0, depth_from_wall),
        (centre_u + width / 2, 0.0, depth_from_wall),
        (centre_u + width / 2, height, depth_from_wall),
        (centre_u - width / 2, height, depth_from_wall),
    ]
    pixels = np.array([project(c, rotation=rotation, centre=centre) for c in corners])
    x0, y0 = pixels.min(axis=0)
    x1, y1 = pixels.max(axis=0)
    return (float(x0), float(y0), float(x1 - x0), float(y1 - y0))


WALL = WallFrame(start=(0.0, 0.0), end=(4.0, 0.0), inward=(0.0, 1.0))


def test_a_sofa_is_measured_and_placed():
    centre = np.array([2.0, 1.5, 3.4])
    pose = CameraPose(rotation=LOOKING_AT_WALL, centre=centre)
    box = _front_face_box(2.0, 0.92, 2.1, 0.83, rotation=LOOKING_AT_WALL, centre=centre)

    placed = place_floor_object(
        box, pose=pose, intrinsics=K, wall=WALL, depth_over_width=0.92 / 2.1
    )

    assert isinstance(placed, PlacedBox)
    # Width and height are measured, so they come back to the millimetre.
    assert placed.size[0] == pytest.approx(2.1, abs=0.005)
    assert placed.size[1] == pytest.approx(0.83, abs=0.005)
    assert placed.size[2] == pytest.approx(0.92, abs=0.005)
    assert placed.measured == ("w", "h")
    # Sits on the floor, centred along the wall, half its depth behind its face.
    assert placed.position[1] == 0.0
    assert placed.position[0] == pytest.approx(2.0, abs=0.01)
    assert placed.position[2] == pytest.approx(0.92 - 0.46, abs=0.01)


def test_depth_is_declared_assumed_not_measured():
    """The one extent a single view cannot see must never claim to be measured."""
    centre = np.array([2.0, 1.5, 3.4])
    pose = CameraPose(rotation=LOOKING_AT_WALL, centre=centre)
    box = _front_face_box(2.0, 0.9, 1.0, 0.5, rotation=LOOKING_AT_WALL, centre=centre)

    shallow = place_floor_object(box, pose=pose, intrinsics=K, wall=WALL, depth_over_width=0.3)
    deep = place_floor_object(box, pose=pose, intrinsics=K, wall=WALL, depth_over_width=0.9)

    # Same pixels, different catalog proportions — proof depth is an assumption.
    assert shallow.size[0] == pytest.approx(deep.size[0])
    assert shallow.size[2] != pytest.approx(deep.size[2])
    assert "d" not in shallow.measured


def test_an_object_never_solves_through_the_wall():
    """An object flush to the wall must not have its centre pushed behind it."""
    centre = np.array([2.0, 1.5, 3.0])
    pose = CameraPose(rotation=LOOKING_AT_WALL, centre=centre)
    box = _front_face_box(2.0, 0.05, 1.2, 1.8, rotation=LOOKING_AT_WALL, centre=centre)

    placed = place_floor_object(box, pose=pose, intrinsics=K, wall=WALL, depth_over_width=0.5)

    assert placed.position[2] >= placed.size[2] / 2.0 - 1e-9


def test_wall_frame_maps_local_metres_into_world():
    # A wall running east along z = 0 with the room to its north (−z is "into"
    # the room only if the normal says so; here the room is at +z).
    assert WALL.width == pytest.approx(4.0)
    assert WALL.to_world(1.0, 0.5) == pytest.approx((1.0, 0.5))
    assert WALL.to_world(0.0, 0.0) == pytest.approx((0.0, 0.0))


def test_wall_frame_yaw_faces_into_the_room():
    yaw = WALL.yaw_facing_room()
    facing = (math.cos(yaw), -math.sin(yaw))
    # Facing away from the wall means facing along the inward normal.
    assert facing[0] == pytest.approx(WALL.inward[0], abs=1e-9)
    assert facing[1] == pytest.approx(WALL.inward[1], abs=1e-9)


def test_a_wall_mounted_tv_is_measured_on_the_wall_plane():
    """A wall mount lies on the plane the pose came from — nothing is assumed
    about its position, only its thickness."""
    from myroom_vision.place import place_wall_object

    centre = np.array([2.0, 1.5, 3.0])
    pose = CameraPose(rotation=LOOKING_AT_WALL, centre=centre)
    # A 1.2 m × 0.7 m screen, centred at u = 2.2, its base 1.0 m off the floor.
    corners = [(1.6, 1.0, 0.0), (2.8, 1.0, 0.0), (2.8, 1.7, 0.0), (1.6, 1.7, 0.0)]
    pixels = np.array([project(c, rotation=LOOKING_AT_WALL, centre=centre) for c in corners])
    x0, y0 = pixels.min(axis=0)
    x1, y1 = pixels.max(axis=0)

    placed = place_wall_object(
        (float(x0), float(y0), float(x1 - x0), float(y1 - y0)),
        pose=pose, intrinsics=K, wall=WALL, thickness=0.08,
    )

    assert placed.size[0] == pytest.approx(1.2, abs=0.005)
    assert placed.size[1] == pytest.approx(0.7, abs=0.005)
    assert placed.size[2] == pytest.approx(0.08, abs=1e-9)
    assert placed.position[0] == pytest.approx(2.2, abs=0.01)
    # Origin is the base: 1.0 m off the floor, not the centre of the screen.
    assert placed.position[1] == pytest.approx(1.0, abs=0.005)
    assert placed.position[2] == pytest.approx(0.04, abs=1e-6)
