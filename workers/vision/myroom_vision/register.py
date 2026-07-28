"""Register a scan to the drawn plan, and report where they disagree.

docs/05 §2: "register scan to the user's plan (floor-plane leveling, then 2D ICP
of extracted wall lines against the drawn polygon)". The output is a *correction*
to what the user drew, and disagreements beyond 0.4 m are surfaced for review
rather than applied silently.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .roomplan import ScanWall

#: Disagreement past which we ask instead of assuming (docs/05 §2).
REVIEW_THRESHOLD_M = 0.4


@dataclass
class Registration:
    rotation: float
    translation: tuple[float, float]
    #: mean distance from scan samples to the drawn outline, metres
    residual: float

    def apply(self, points: np.ndarray) -> np.ndarray:
        c, s = np.cos(self.rotation), np.sin(self.rotation)
        rotation = np.array([[c, -s], [s, c]])
        return points @ rotation.T + np.asarray(self.translation)


def sample_segments(segments: np.ndarray, spacing: float = 0.1) -> np.ndarray:
    """Evenly sample points along ``(n, 2, 2)`` segments."""
    out: list[np.ndarray] = []
    for a, b in segments:
        length = float(np.linalg.norm(b - a))
        steps = max(2, int(length / spacing) + 1)
        t = np.linspace(0.0, 1.0, steps)[:, None]
        out.append(a + (b - a) * t)
    return np.vstack(out) if out else np.zeros((0, 2))


def point_segment_distance(points: np.ndarray, segments: np.ndarray) -> np.ndarray:
    """Distance from each point to the nearest segment."""
    a = segments[:, 0, :]
    b = segments[:, 1, :]
    ab = b - a
    denom = np.einsum("ij,ij->i", ab, ab)
    denom[denom == 0] = 1e-12
    ap = points[:, None, :] - a[None, :, :]
    t = np.clip(np.einsum("nij,ij->ni", ap, ab) / denom, 0.0, 1.0)
    closest = a[None, :, :] + t[:, :, None] * ab[None, :, :]
    return np.linalg.norm(points[:, None, :] - closest, axis=2).min(axis=1)


def _segments(walls: list[ScanWall]) -> np.ndarray:
    if not walls:
        return np.zeros((0, 2, 2))
    return np.asarray([[list(w.start), list(w.end)] for w in walls], dtype=float)


def register_walls(
    scan_walls: list[ScanWall],
    plan_loop: list[tuple[float, float]],
    *,
    icp_iterations: int = 20,
) -> Registration | None:
    """Best rigid 2D transform taking scan walls onto the drawn outline.

    Candidate rotations come from pairing each scan wall's heading with each
    drawn wall's heading — a room's walls are its own best feature descriptor,
    and this avoids the local minimum a cold-start ICP falls into when the scan
    is 90° out.
    """
    if len(scan_walls) < 2 or len(plan_loop) < 3:
        return None

    plan = np.asarray(plan_loop, dtype=float)
    plan_segments = np.stack([plan, np.roll(plan, -1, axis=0)], axis=1)
    scan_segments = _segments(scan_walls)
    scan_points = sample_segments(scan_segments)
    if len(scan_points) == 0:
        return None

    scan_centroid = scan_points.mean(axis=0)
    plan_centroid = sample_segments(plan_segments).mean(axis=0)

    def heading(segments: np.ndarray) -> np.ndarray:
        delta = segments[:, 1, :] - segments[:, 0, :]
        return np.arctan2(delta[:, 1], delta[:, 0])

    candidates = set()
    for scan_angle in heading(scan_segments):
        for plan_angle in heading(plan_segments):
            # Walls are undirected, so every 90°/180° flip is also a candidate.
            for quarter in range(4):
                candidates.add(float(plan_angle - scan_angle + quarter * np.pi / 2))

    best: Registration | None = None
    for angle in candidates:
        c, s = np.cos(angle), np.sin(angle)
        rotation = np.array([[c, -s], [s, c]])
        translation = plan_centroid - (scan_centroid @ rotation.T)
        current = Registration(angle, (float(translation[0]), float(translation[1])), np.inf)

        for _ in range(icp_iterations):
            moved = current.apply(scan_points)
            residual = float(point_segment_distance(moved, plan_segments).mean())
            if abs(residual - current.residual) < 1e-5:
                current.residual = residual
                break
            current.residual = residual
            # Point-to-segment ICP step: pull each sample onto its nearest
            # projection, then re-solve the rigid transform in closed form.
            targets = _nearest_points(moved, plan_segments)
            current = _kabsch_2d(scan_points, targets)
            current.residual = float(point_segment_distance(current.apply(scan_points), plan_segments).mean())

        if best is None or current.residual < best.residual:
            best = current

    return best


def _nearest_points(points: np.ndarray, segments: np.ndarray) -> np.ndarray:
    a = segments[:, 0, :]
    b = segments[:, 1, :]
    ab = b - a
    denom = np.einsum("ij,ij->i", ab, ab)
    denom[denom == 0] = 1e-12
    ap = points[:, None, :] - a[None, :, :]
    t = np.clip(np.einsum("nij,ij->ni", ap, ab) / denom, 0.0, 1.0)
    closest = a[None, :, :] + t[:, :, None] * ab[None, :, :]
    index = np.linalg.norm(points[:, None, :] - closest, axis=2).argmin(axis=1)
    return closest[np.arange(len(points)), index]


def _kabsch_2d(source: np.ndarray, target: np.ndarray) -> Registration:
    src_c = source.mean(axis=0)
    dst_c = target.mean(axis=0)
    h = (source - src_c).T @ (target - dst_c)
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T))
    rotation = vt.T @ np.diag([1.0, d]) @ u.T
    angle = float(np.arctan2(rotation[1, 0], rotation[0, 0]))
    translation = dst_c - src_c @ rotation.T
    return Registration(angle, (float(translation[0]), float(translation[1])), np.inf)


@dataclass
class Disagreement:
    wall_id: str
    wall_label: str
    drawn_length: float
    scanned_length: float
    delta: float
    needs_review: bool


def compare_lengths(
    drawn: list[dict],
    scan_walls: list[ScanWall],
    registration: Registration,
    *,
    threshold: float = REVIEW_THRESHOLD_M,
) -> list[Disagreement]:
    """Per-wall length comparison after registration.

    Matching is by direction and overlap, not by index: a scan can find walls in
    any order, and can miss one entirely.
    """
    out: list[Disagreement] = []
    moved = [
        ScanWall(
            tuple(registration.apply(np.asarray([w.start]))[0]),
            tuple(registration.apply(np.asarray([w.end]))[0]),
            w.height,
        )
        for w in scan_walls
    ]

    for wall in drawn:
        a = np.asarray(wall["start"], dtype=float)
        b = np.asarray(wall["end"], dtype=float)
        drawn_length = float(np.linalg.norm(b - a))
        if drawn_length <= 0:
            continue
        direction = (b - a) / drawn_length
        midpoint = (a + b) / 2

        best: tuple[float, ScanWall] | None = None
        for candidate in moved:
            ca = np.asarray(candidate.start)
            cb = np.asarray(candidate.end)
            candidate_length = float(np.linalg.norm(cb - ca))
            if candidate_length <= 0:
                continue
            candidate_dir = (cb - ca) / candidate_length
            # Parallel within ~15°, in either direction.
            if abs(float(candidate_dir @ direction)) < np.cos(np.deg2rad(15)):
                continue
            offset = float(np.linalg.norm(((ca + cb) / 2) - midpoint))
            if best is None or offset < best[0]:
                best = (offset, candidate)

        # Nothing plausibly the same wall: the scan simply didn't see it.
        if best is None or best[0] > max(1.0, drawn_length / 2):
            continue
        scanned_length = best[1].length
        delta = scanned_length - drawn_length
        out.append(
            Disagreement(
                wall_id=str(wall.get("id", "")),
                wall_label=str(wall.get("label", "")),
                drawn_length=drawn_length,
                scanned_length=scanned_length,
                delta=delta,
                needs_review=abs(delta) > threshold,
            )
        )
    return out
