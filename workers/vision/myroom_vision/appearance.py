"""Stage 5 — appearance extraction (docs/05 §7).

"dominant-color palette (k-means in Lab space over the mask crop,
lighting-normalized) applied to the matched model's designated albedo slots".

Lab rather than RGB because k-means needs a space where distance means
*perceived* difference; clustering in RGB merges a navy cushion with a black one
and splits two shades of beige.
"""

from __future__ import annotations

import numpy as np

#: D65 white point, the reference sRGB is defined against.
_WHITE = np.array([0.95047, 1.0, 1.08883])

_RGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]
)


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    rgb = np.clip(np.asarray(rgb, dtype=float), 0.0, 1.0)
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(linear: np.ndarray) -> np.ndarray:
    linear = np.clip(np.asarray(linear, dtype=float), 0.0, 1.0)
    return np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055)


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB in 0–1 → CIE Lab. Accepts ``(n, 3)``."""
    linear = srgb_to_linear(rgb)
    xyz = linear @ _RGB_TO_XYZ.T / _WHITE
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16.0 / 116.0)
    return np.stack(
        [116.0 * f[:, 1] - 16.0, 500.0 * (f[:, 0] - f[:, 1]), 200.0 * (f[:, 1] - f[:, 2])],
        axis=1,
    )


def lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    lab = np.asarray(lab, dtype=float)
    fy = (lab[:, 0] + 16.0) / 116.0
    fx = fy + lab[:, 1] / 500.0
    fz = fy - lab[:, 2] / 200.0
    f = np.stack([fx, fy, fz], axis=1)
    xyz = np.where(f**3 > 0.008856, f**3, (f - 16.0 / 116.0) / 7.787) * _WHITE
    linear = xyz @ np.linalg.inv(_RGB_TO_XYZ).T
    srgb = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.clip(linear, 0, None) ** (1 / 2.4) - 0.055)
    return np.clip(srgb, 0.0, 1.0)


def normalize_illumination(rgb: np.ndarray, target_luminance: float = 0.22) -> np.ndarray:
    """Divide out the light level, in linear space where light actually scales.

    A sofa photographed in a dim corner and the same sofa by the window should
    yield the same swatch; only the illumination differed. Normalizing in sRGB
    would not cancel it — the transfer curve turns a brightness change into a
    chroma change, which is exactly the error this removes.
    """
    linear = srgb_to_linear(rgb)
    if len(linear) == 0:
        return np.asarray(rgb, dtype=float)
    luminance = linear @ _RGB_TO_XYZ[1]
    median = float(np.median(luminance))
    if median <= 1e-6:
        return np.asarray(rgb, dtype=float)
    return linear_to_srgb(linear * (target_luminance / median))


def kmeans(points: np.ndarray, k: int, *, iterations: int = 25, seed: int = 7) -> tuple[np.ndarray, np.ndarray]:
    """Lloyd's algorithm with k-means++ seeding. Returns ``(centres, labels)``."""
    rng = np.random.default_rng(seed)
    points = np.asarray(points, dtype=float)
    k = max(1, min(k, len(points)))

    centres = [points[rng.integers(len(points))]]
    for _ in range(1, k):
        distances = np.min(
            np.linalg.norm(points[:, None, :] - np.asarray(centres)[None, :, :], axis=2), axis=1
        )
        total = distances.sum()
        if total <= 0:
            centres.append(points[rng.integers(len(points))])
            continue
        centres.append(points[rng.choice(len(points), p=distances / total)])
    centre_array = np.asarray(centres)

    labels = np.zeros(len(points), dtype=int)
    for _ in range(iterations):
        labels = np.argmin(np.linalg.norm(points[:, None, :] - centre_array[None, :, :], axis=2), axis=1)
        moved = False
        for i in range(len(centre_array)):
            members = points[labels == i]
            if len(members) == 0:
                continue
            new_centre = members.mean(axis=0)
            if not np.allclose(new_centre, centre_array[i]):
                centre_array[i] = new_centre
                moved = True
        if not moved:
            break
    return centre_array, labels


def hex_of(rgb: np.ndarray) -> str:
    values = np.clip(np.rint(np.asarray(rgb) * 255), 0, 255).astype(int)
    return "#{:02X}{:02X}{:02X}".format(*values)


def dominant_palette(
    pixels: np.ndarray,
    *,
    mask: np.ndarray | None = None,
    colours: int = 3,
) -> list[str]:
    """Dominant colours of a masked crop, most-covering first.

    ``pixels`` is ``(h, w, 3)`` or ``(n, 3)`` sRGB in 0–1 (or 0–255).
    """
    array = np.asarray(pixels, dtype=float)
    if array.ndim == 3:
        if mask is not None:
            array = array[np.asarray(mask).astype(bool)]
        else:
            array = array.reshape(-1, 3)
    if array.size == 0:
        return []
    if array.max() > 1.0:
        array = array / 255.0

    lab = srgb_to_lab(normalize_illumination(array))
    centres, labels = kmeans(lab, colours)
    counts = np.bincount(labels, minlength=len(centres))
    order = np.argsort(counts)[::-1]
    swatches = lab_to_srgb(centres[order])
    return [hex_of(swatch) for swatch, count in zip(swatches, counts[order]) if count > 0]
