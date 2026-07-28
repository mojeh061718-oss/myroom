"""Placing photographed objects without a depth model (docs/05 §4–§5).

The blueprint's stage 2/3 path runs metric monocular depth and back-projects a
mask through it. That needs a GPU. This module is the alternative that does not:
it recovers the camera pose from a *known rectangle* — the wall the photo was
tagged to, whose width comes from the drawn plan and whose height is the ceiling
height — and then intersects rays with the room's own planes.

The trade is explicit. Depth gives every pixel a distance, so it measures an
object's front-to-back extent directly. A single view of a known plane gives
position, lateral width and height honestly, but *not* depth-away-from-camera
for the object itself; that comes from the catalog's proportions for the matched
class. Rooms built this way stay in the "photo" accuracy tier, never "lidar".

Conventions follow the rest of the project: metres, radians, Y-up, plan (x, y)
maps to world (x, −z), and an object's origin is its base.

Wall-local frame used throughout:

    u — along the wall, from its start vertex toward its end vertex
    v — up from the floor (so the floor is the plane v = 0)
    w — into the room, perpendicular to the wall (the wall is the plane w = 0)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: Below this, a homography is too degenerate to trust (near-collinear corners).
MIN_QUAD_AREA_FRACTION = 0.01


class Unlocalizable(ValueError):
    """The photo could not be tied to the room — the caller should skip it.

    Raised rather than returning an approximate pose on purpose: a wrong pose
    puts furniture through walls, which is worse than a room that says one photo
    could not be used.
    """


@dataclass(frozen=True)
class CameraPose:
    """Where the camera was, in the tagged wall's local frame."""

    #: Rotation from wall-local axes into camera axes.
    rotation: np.ndarray
    #: Camera centre in wall-local coordinates, metres.
    centre: np.ndarray

    def ray(self, pixel: tuple[float, float], intrinsics: np.ndarray) -> np.ndarray:
        """Unit direction in wall-local coordinates for an image pixel."""
        homogeneous = np.array([pixel[0], pixel[1], 1.0], dtype=float)
        direction = self.rotation.T @ (np.linalg.inv(intrinsics) @ homogeneous)
        norm = float(np.linalg.norm(direction))
        if norm == 0.0:
            raise Unlocalizable("degenerate ray")
        return direction / norm


def _quad_area(quad: np.ndarray) -> float:
    """Shoelace area of a 4-gon given in order."""
    x, y = quad[:, 0], quad[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def homography_from_quad(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Direct linear transform for four point correspondences.

    ``source`` is in wall-local (u, v) metres, ``target`` in pixels, both in the
    same order.
    """
    rows: list[list[float]] = []
    for (u, v), (px, py) in zip(source, target):
        rows.append([-u, -v, -1.0, 0.0, 0.0, 0.0, px * u, px * v, px])
        rows.append([0.0, 0.0, 0.0, -u, -v, -1.0, py * u, py * v, py])
    _, _, vt = np.linalg.svd(np.asarray(rows, dtype=float))
    homography = vt[-1].reshape(3, 3)
    if abs(homography[2, 2]) < 1e-12:
        raise Unlocalizable("degenerate wall homography")
    return homography / homography[2, 2]


def pose_from_wall_quad(
    quad_px: np.ndarray,
    *,
    wall_width: float,
    wall_height: float,
    intrinsics: np.ndarray,
    image_size: tuple[int, int],
) -> CameraPose:
    """Recover the camera pose from the four corners of a wall of known size.

    ``quad_px`` is the wall's corners in pixels, in the order bottom-left,
    bottom-right, top-right, top-left as seen in the image. The wall is a
    rectangle of known metric size, so this is the textbook plane-to-image
    homography decomposition: ``H = K [r1 r2 t]`` up to scale.
    """
    quad_px = np.asarray(quad_px, dtype=float)
    if quad_px.shape != (4, 2):
        raise Unlocalizable("a wall quad needs exactly four corners")
    if not np.isfinite(quad_px).all():
        raise Unlocalizable("wall quad has non-finite corners")
    if wall_width <= 0 or wall_height <= 0:
        raise Unlocalizable("wall dimensions must be positive")

    width_px, height_px = image_size
    if _quad_area(quad_px) < MIN_QUAD_AREA_FRACTION * width_px * height_px:
        raise Unlocalizable("wall quad is too small or too close to collinear")

    model = np.array(
        [[0.0, 0.0], [wall_width, 0.0], [wall_width, wall_height], [0.0, wall_height]],
        dtype=float,
    )
    homography = homography_from_quad(model, quad_px)

    normalized = np.linalg.inv(intrinsics) @ homography
    # The two in-plane columns share one scale; averaging their norms is steadier
    # than trusting either alone when the corners carry a pixel or two of error.
    scale = 2.0 / (np.linalg.norm(normalized[:, 0]) + np.linalg.norm(normalized[:, 1]))
    if not np.isfinite(scale) or scale == 0.0:
        raise Unlocalizable("wall homography has no recoverable scale")
    r1, r2, translation = (normalized[:, 0] * scale, normalized[:, 1] * scale, normalized[:, 2] * scale)
    if translation[2] < 0:
        r1, r2, translation = -r1, -r2, -translation

    rotation = np.column_stack([r1, r2, np.cross(r1, r2)])
    # Force orthonormality: the decomposition above is only approximately a
    # rotation once measurement error is in the corners.
    u_svd, _, vt_svd = np.linalg.svd(rotation)
    rotation = u_svd @ vt_svd
    if np.linalg.det(rotation) < 0:
        u_svd[:, -1] *= -1
        rotation = u_svd @ vt_svd

    centre = -rotation.T @ translation
    # The camera must be inside the room, i.e. on the positive side of the wall.
    # The homography's model frame has the wall normal pointing at the camera, so
    # a negative w here means the corner order was wound the wrong way.
    if centre[2] <= 0:
        raise Unlocalizable("camera solved to behind the wall — check corner order")
    return CameraPose(rotation=rotation, centre=centre)


def floor_point(pose: CameraPose, pixel: tuple[float, float], intrinsics: np.ndarray) -> np.ndarray:
    """Where a pixel's ray meets the floor, in wall-local metres.

    Returns ``(u, 0, w)``. Raises when the ray points at or above the horizon,
    which is what a box whose base is cropped out of frame looks like.
    """
    direction = pose.ray(pixel, intrinsics)
    if direction[1] >= -1e-6:
        raise Unlocalizable("ray does not descend to the floor")
    distance = -pose.centre[1] / direction[1]
    if distance <= 0:
        raise Unlocalizable("floor intersection is behind the camera")
    return pose.centre + distance * direction


def height_at(
    pose: CameraPose,
    pixel: tuple[float, float],
    intrinsics: np.ndarray,
    *,
    depth_from_wall: float,
) -> float:
    """Height of a pixel that sits directly above a point at a known distance.

    Used for an object's top edge: it is above the object's base, so it shares
    the base's distance from the wall. Intersecting the ray with that
    wall-parallel plane turns the pixel into a metre height.
    """
    direction = pose.ray(pixel, intrinsics)
    denominator = direction[2]
    if abs(denominator) < 1e-9:
        raise Unlocalizable("ray runs parallel to the wall")
    distance = (depth_from_wall - pose.centre[2]) / denominator
    if distance <= 0:
        raise Unlocalizable("top edge solves to behind the camera")
    return float(pose.centre[1] + distance * direction[1])


def wall_plane_point(pose: CameraPose, pixel: tuple[float, float], intrinsics: np.ndarray) -> np.ndarray:
    """Where a pixel's ray meets the wall itself, in wall-local metres.

    Returns ``(u, v, 0)``. This is what makes wall mounts — a TV, a framed
    picture, a floating shelf — placeable from one photo: they lie *on* the plane
    whose geometry the pose was solved from, so no depth is involved at all.
    """
    direction = pose.ray(pixel, intrinsics)
    if abs(direction[2]) < 1e-9:
        raise Unlocalizable("ray runs parallel to the wall")
    distance = -pose.centre[2] / direction[2]
    if distance <= 0:
        raise Unlocalizable("wall intersection is behind the camera")
    return pose.centre + distance * direction


@dataclass(frozen=True)
class WallFrame:
    """The tagged wall's placement in world coordinates.

    ``start`` and ``end`` are the wall's base endpoints as world (x, z), and
    ``inward`` is the unit normal pointing into the room.
    """

    start: tuple[float, float]
    end: tuple[float, float]
    inward: tuple[float, float]

    @property
    def width(self) -> float:
        return float(np.hypot(self.end[0] - self.start[0], self.end[1] - self.start[1]))

    def to_world(self, u: float, w: float) -> tuple[float, float]:
        """Wall-local (u, w) to world (x, z)."""
        width = self.width
        if width == 0:
            raise Unlocalizable("degenerate wall")
        along = np.array([self.end[0] - self.start[0], self.end[1] - self.start[1]]) / width
        inward = np.asarray(self.inward, dtype=float)
        point = np.asarray(self.start, dtype=float) + u * along + w * inward
        return float(point[0]), float(point[1])

    def yaw_facing_room(self) -> float:
        """Yaw for an object with its back to this wall, looking into the room.

        Most furniture sits parallel to a wall, and a photo-tier estimate of a
        few degrees of rotation is noise dressed up as a measurement. Objects
        are squared to the wall they were seen against; the user can rotate.

        Yaw follows the project convention: a direction (dx, dz) in world
        coordinates has yaw ``atan2(−dz, dx)``.
        """
        return float(np.arctan2(-self.inward[1], self.inward[0]))

    def yaw_facing_wall(self) -> float:
        """Yaw for an object turned toward this wall — a TV on a wall mount."""
        return self.yaw_facing_room() + float(np.pi)


@dataclass(frozen=True)
class PlacedBox:
    """A measured object, in the same shape stage 3 already emits."""

    position: tuple[float, float, float]
    rotation_y: float
    size: tuple[float, float, float]
    #: Which extents were measured from the image rather than assumed.
    measured: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "position": {"x": self.position[0], "y": self.position[1], "z": self.position[2]},
            "rotationY": self.rotation_y,
            "size": {"w": self.size[0], "h": self.size[1], "d": self.size[2]},
        }


def place_floor_object(
    box_px: tuple[float, float, float, float],
    *,
    pose: CameraPose,
    intrinsics: np.ndarray,
    wall: WallFrame,
    depth_over_width: float,
) -> PlacedBox:
    """Turn a detection box on a floor-standing object into a world box.

    Width and height are measured: the box's two bottom corners ray-cast to the
    floor give a real metric span, and the top edge gives a real height. Depth
    is the one extent a single view cannot see, so it comes from the class's
    catalog proportions scaled to the measured width — recorded in ``measured``
    so nothing downstream mistakes it for an observation.
    """
    x, y, w, h = (float(v) for v in box_px)
    if w <= 0 or h <= 0:
        raise Unlocalizable("detection box has no area")

    left = floor_point(pose, (x, y + h), intrinsics)
    right = floor_point(pose, (x + w, y + h), intrinsics)
    base = (left + right) / 2.0

    width = float(np.linalg.norm(right[[0, 2]] - left[[0, 2]]))
    if width <= 0.01:
        raise Unlocalizable("object solves to less than a centimetre wide")

    height = height_at(pose, (x + w / 2.0, y), intrinsics, depth_from_wall=float(base[2]))
    if height <= 0.01:
        raise Unlocalizable("object solves to no height")

    depth = max(0.05, width * depth_over_width)
    # The base ray hit the object's *front* bottom edge — the face turned toward
    # the camera. Its centre is half a depth further from the camera, i.e. half a
    # depth nearer the wall, and never through it.
    centre_u = float(base[0])
    centre_w = max(depth / 2.0, float(base[2]) - depth / 2.0)
    world_x, world_z = wall.to_world(centre_u, centre_w)
    return PlacedBox(
        position=(world_x, 0.0, world_z),
        rotation_y=wall.yaw_facing_room(),
        size=(width, height, depth),
        measured=("w", "h"),
    )


def place_wall_object(
    box_px: tuple[float, float, float, float],
    *,
    pose: CameraPose,
    intrinsics: np.ndarray,
    wall: WallFrame,
    thickness: float,
) -> PlacedBox:
    """Turn a detection box on a wall-mounted object into a world box.

    Wall mounts are the easy case, not the hard one: the object lies on the plane
    the pose was solved from, so its box corners ray-cast straight onto it and
    both visible extents are measured. Only its thickness off the wall is
    assumed, from the class's catalog depth.
    """
    x, y, w, h = (float(v) for v in box_px)
    if w <= 0 or h <= 0:
        raise Unlocalizable("detection box has no area")

    bottom_left = wall_plane_point(pose, (x, y + h), intrinsics)
    bottom_right = wall_plane_point(pose, (x + w, y + h), intrinsics)
    top_left = wall_plane_point(pose, (x, y), intrinsics)

    width = float(abs(bottom_right[0] - bottom_left[0]))
    height = float(abs(top_left[1] - bottom_left[1]))
    if width <= 0.01 or height <= 0.01:
        raise Unlocalizable("wall mount solves to no size")

    centre_u = float((bottom_left[0] + bottom_right[0]) / 2.0)
    depth = max(0.02, thickness)
    world_x, world_z = wall.to_world(centre_u, depth / 2.0)
    return PlacedBox(
        # A wall mount's origin is still its base — its height off the floor.
        position=(world_x, float(min(bottom_left[1], top_left[1])), world_z),
        rotation_y=wall.yaw_facing_room(),
        size=(width, height, depth),
        measured=("w", "h"),
    )
